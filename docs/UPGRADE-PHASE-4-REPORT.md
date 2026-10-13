# Platform upgrade, Phase 4 — the loan module, reorganised

Phase 4 of the plan in `PLATFORM-UPGRADE-PLAN.md`: a refusal that is
distinguishable from a withdrawal, the questions a product actually asks,
guarantors captured on the application they guarantee with a versioned
undertaking, and a register that navigates by where a loan is in the
workflow rather than by its lifecycle status alone.

How the module works is in `LOANS.md` and `LOAN-PRODUCTS.md`. This is the
evidence that it was applied, that it holds, and that nothing already working
was broken.

---

## 1. Migrations added

| Migration | What it does |
| --- | --- |
| `20261013000100_loan_closure_kind.sql` | `loans.closure_kind` with the invariant that a cancelled loan has exactly one; `reject_loan` beside `cancel_loan`, so a credit decision and a change of mind are different events in the same terminal state. |
| `20261013000200_loan_application_details.sql` | `loan_salary_details` and `loan_business_details` — one typed table per application profile, editable in draft and frozen from submission; `loan_application_profile`. |
| `20261013000300_loan_guarantors.sql` | `loan_guarantors`: a loan's own guarantors, either an existing client or an external person, with versioned consent; `guarantor_consent_terms` and version 1.0 of the undertaking; the business's guarantor rules in `business_settings`; `loan_guarantor_register`; the backfill of 40 rows from the snapshots and the client register. |
| `20261013000400_approval_reads_the_application.sql` | The validator counts the application's own guarantors and the product's own questions; the guarantor evidence is frozen onto `loan_guarantors` at approval, with `loan_guarantor_evidence` presenting both eras as one list. |
| `20261013000500_loan_workflow_and_documents.sql` | Two defects in the lifecycle guard (below); `loan_documents` and the `loan-documents` bucket; three further answers the brief asks for; `loan_workflow_register`; `guarantor_candidates`. |
| `20261013000600_consent_is_not_an_attachment.sql` | Narrows the eligibility trigger's column list so signing an undertaking does not re-run the concentration rule. |

The first four were written and applied to a clean local database in the
session that checkpointed at `7f6ba6b`; `…500` and `…600` are this session's,
and both were found by building the screens over the first four.

## 2. Two defects the application layer found

Neither was visible from the function that caused it, and neither had a
failing test until a person tried to do the thing.

**A Manager could approve an application but not refuse one.** `reject_loan`
checks `loans:approve`, on the stated reasoning that a business which can
grant the power to say yes without the power to say no is not one anybody
wants. It then performs an UPDATE to `status = 'cancelled'`, and
`loans_guard_transition` — which predates the idea of a refusal — demanded
`loans:cancel` for *any* move to that state. The Manager role holds the first
and not the second, so the one role the function was written for was the one
role it refused. The guard now reads the kind: a refusal needs
`loans:approve`, a withdrawal needs `loans:cancel`.

**The product was frozen everywhere except in the schema.**
`capture_loan_product_snapshot` records a loan's product and rate at approval,
and the transition guard freezes the principal, term, cadence, borrower and
agreed rate once a loan leaves draft — but not `loan_product_id` or
`proposed_interest_rate_bps`. An approved loan could be moved to a different
product and would then disagree with its own snapshot, with every report by
product picking whichever one it happened to read. Both columns are now
frozen with the rest.

A third, smaller one surfaced while enriching the demo: the eligibility
trigger fired on the consent columns, so a guarantor who reached the
concentration limit *after* being attached could neither sign the undertaking
nor be removed from the application. `…600` moves the rule back to the moment
it belongs to — taking on a guarantee, not signing for one already taken on.

## 3. Schema changes

New tables: `loan_salary_details`, `loan_business_details`, `loan_guarantors`,
`guarantor_consent_terms`, `loan_documents`.

New views: `loan_application_profile`, `loan_guarantor_register`,
`loan_guarantor_evidence`, `loan_workflow_register`.

New functions: `reject_loan`, `guarantor_candidates`, `storage_path_loan_id`,
plus six trigger functions and one audit trigger function. Re-emitted:
`loans_guard_transition`, `validate_loan_for_approval`, `approve_loan`,
`cancel_loan`.

Columns added: `loans.closure_kind`; `guarantors.employer_name`;
`business_settings.allow_client_as_guarantor`,
`.guarantor_min_age_years`, `.guarantor_max_active_loans`;
`loan_guarantor_snapshots` gains seven consent and subject columns;
`loan_salary_details.employment_status`, `.salary_verification`;
`loan_business_details.monthly_expenses`, `.business_contact`;
`loan_guarantors` gains eleven `snapshot_*` columns at approval.

New bucket: `loan-documents`, private like the other three, with three
storage policies reading `storage_path_loan_id(name)`.

New capabilities: `loans:documents` (the three staff roles),
`guarantor_terms:manage` (the Owner alone).

Local, after all six: 45 tables, 25 views, 129 functions, 80 policies, 69
permissions.

## 4. Application layer

| Route | What it is |
| --- | --- |
| `/loans` | The register, with the workflow strip: eleven stages plus the whole book, each a filter on `loan_workflow_register`. Product filter beside the search. |
| `/loans/by-product` | The portfolio grouped by product, each row linking back into the register filtered to it. |
| `/loans/new` | Product first, then the borrower, then amount and period — the form narrows to the product's own amounts, periods, cadences and rate. |
| `/loans/[loanId]/application` | The application workspace: the product's own questions, the guarantors and their undertakings, the documents. Editable in draft, read-only from submission. |
| `/loans/[loanId]` | Gains the product on the terms, a guarantors-and-security section covering both eras, the product's answers, the documents filed, and a refusal control beside the approval. |

Server actions added: `rejectLoanAction`, `saveSalaryDetailsAction`,
`saveBusinessDetailsAction`, `attachClientGuarantorAction`,
`attachExternalGuarantorAction`, `removeLoanGuarantorAction`,
`recordGuarantorConsentAction`, `uploadLoanDocumentAction`,
`removeLoanDocumentAction`.

Components added: `loan-workflow-tabs`, `application-details-form`,
`loan-guarantor-section`, `loan-documents-panel`. Modules added:
`lib/domain/guarantor.ts`, `lib/validation/loan-application.ts`,
`lib/data/loan-application.ts`, `lib/loans/application-actions.ts`,
`lib/storage/loan-documents.ts`.

### A performance regression, and what it cost to fix

The register's new "By product" action pushed `/loans` from 55 network
requests to 57, against a budget of 55 — and measuring the others turned up
`/reports` at 65 and `/payments/new` at 59, both of which had been inside the
budget only by accident. The cause in all three was `<Link>` rendered once per
row: six report cards, their period chips, three highlight tiles and every
loan in the payment picker, each prefetching a page nobody asked for. They now
use `RowLink`, which is what it exists for, and the secondary action on the
register does not prefetch. `/reports` fell from 65 requests to 49.

## 5. Live application

All six applied to the demo project `fszgwemtgyrbhngajpzm`.

**A registry correction first.** 13.1 and 13.2 had been applied through the
Supabase MCP, which stamps the version with the time of application rather
than the migration's own — so live held them as `20261009162801` and
`20261009162842`, out of order with the repository and invisible to a
`db push` that would then re-apply them. The same would have happened to
13.3–13.6. All six registry rows were renamed to their repository versions, so
the live registry now reads `20261013000100` through `20261013000600` in
order.

**Verified after.** The live schema was compared object-for-object against a
local database built from every migration: 527 constraints, 80 policies, 121
triggers, 69 permissions and 149 role grants all hash identically, as do the
column list, the view column lists and the storage policies. All 129 function
bodies hash identically once `--` comments are normalised away — the same
difference every earlier phase recorded, and for the same reason.

One live-only object remains and is not ours: a view `public.__gate_probe`
defined as `SELECT 1 AS one`, left by an earlier session. It is inert, nothing
references it, and removing an object from a live database is not something
this phase did on its own initiative.

## 6. Demo data

Preserved, and enriched only where Phase 4 needs something to show.

- The five open applications were given real products: LN260030 a Quick Loan,
  LN260031 a Business Loan with its business details, LN260027 a Salary Loan
  with its employment details, LN260028 and LN260029 Individual Loans.
- Every guarantor on every open application has now signed version 1.0 of the
  undertaking — nine consents, each with a signatory, a witness and a place.
  The three that had already been submitted were returned for correction, the
  consent taken, and resubmitted, which is the remedy a reviewer would
  actually use rather than a trigger switched off.
- LN260031 carries an **existing-client guarantor** (Amanya Edgar
  Rwomushana, CL26018) beside its external one.
- Two new applications close the gap the demo had: **LN260034 refused** by the
  Manager on a credit judgement, and **LN260035 withdrawn** by the Owner
  because the borrower changed their mind. Same terminal state, two closure
  kinds, both with a reason and an actor.
- Two external guarantors were added to the register with their
  identification, as the application form would have captured them.

LN260031's borrower is blacklisted, so the application screen reports
`client_not_active` and the loan cannot be approved. That is left as it
stands: it is pre-existing demo data and it demonstrates the validator
refusing for a reason a person can act on.

**Live totals:** 35 loans — 2 draft, 3 pending approval, 2 approved, 17
active, 9 cleared, 1 rejected, 1 withdrawn. 43 loan-guarantor rows, of which
1 is an existing client and 9 carry a signed undertaking. 16 guarantors in the
register. 1 salary application, 1 business application.

**The books are untouched.** No financial event was created or altered:
the trial balance stands at 70,196,030 on both sides, Cash at Hand
1,846,418, MTN 10,974,067, Airtel 4,115,545, Bank 0, Loans Receivable
8,978,697, Interest Income 4,448,123, Penalty Income 17,441.

## 7. Verification

| Suite | Result |
| --- | --- |
| Typecheck | clean |
| Lint | clean |
| Formatting | clean |
| Unit + integration | 54 files, 1,850 tests, all passing |
| Database (real PostgreSQL) | 43 files, 1,184 tests, all passing |
| Production build | succeeds |
| Browser (Playwright, 2 viewports) | see the final line of this report |

The browser suite drives the whole of Phase 4 end to end: a product-first
application, a guarantor captured from inside it, the undertaking shown in
full and signed, submission, approval, disbursement, and then the frozen
guarantor evidence read back off the loan. A second spec covers the workflow
strip, the by-product view, the read-only application, the candidate search
and a Manager refusing an application — the defect in §2, as a test.

## 8. What Phase 4 did not do

- **Collateral and security** are named on a product (`collateral_required`)
  and not yet recorded. The application screen says so where a product
  requires it. Phase 5.
- **Guarantor concentration is counted when a guarantee is taken on, not at
  approval.** Three applications naming the same guarantor can each be
  approved and leave them behind three active loans. Closing it properly
  means exposure rather than a count, which is Phase 5's guarantor register.
- **A document is listed, not opened.** The paths are stored and the bucket
  and its policies exist; the signed-URL read is wired
  (`signedLoanDocumentUrl`) but no screen offers the link yet, because a
  document viewer belongs with the rest of the evidence surface in Phase 5.
