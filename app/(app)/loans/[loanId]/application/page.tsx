import { ClipboardList } from 'lucide-react';
import { notFound } from 'next/navigation';

import {
  BusinessDetailsForm,
  SalaryDetailsForm,
} from '@/components/loans/application-details-form';
import { LoanDocumentsPanel } from '@/components/loans/loan-documents-panel';
import { LoanGuarantorSection } from '@/components/loans/loan-guarantor-section';
import { LoanStatusBadge } from '@/components/loans/loan-status-badge';
import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { SectionTabs } from '@/components/ui/section-tabs';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import {
  getCurrentConsentTerms,
  getLoanApplicationProfile,
  getLoanDocuments,
  getLoanGuarantors,
  searchGuarantorCandidates,
} from '@/lib/data/loan-application';
import { getLoan, loanApprovalFailures } from '@/lib/data/loans';
import { getLoanProduct } from '@/lib/data/products';
import { describeLoanApprovalFailure, termsAreEditable } from '@/lib/domain/loan';

export const metadata = { title: 'Loan application' };

/**
 * The application behind a loan: the product's own questions, the guarantors
 * who agreed to stand behind it, and the documents filed with it.
 *
 * ## Why this is a second page rather than more of the loan page
 *
 * The loan page answers "where does this loan stand" — terms, balance,
 * schedule, payments, history. This page answers "what did the business
 * actually collect before it agreed". Those are different jobs done at
 * different times by different people, and putting both on one route produced
 * a screen a staff member scrolled past rather than read.
 *
 * The brief is explicit about it: no one giant overwhelming form.
 *
 * ## Everything here is editable only in draft
 *
 * The guards in the database say so — `loan_application_details_guard`,
 * `loan_documents_guard`, `loan_guarantors_check_eligibility` — and this page
 * renders a read-only view once the loan has left draft rather than a form
 * that submits into a refusal. The rule is not duplicated as a check; it is
 * read off the loan's own status, which is the same thing the guards read.
 */
export default async function LoanApplicationPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly loanId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { loanId } = await params;
  const context = await guardPermission(
    `${ROUTES.loans}/${loanId}/application`,
    'loans:view',
  );

  const loan = await getLoan(loanId);

  if (loan === null) notFound();

  const search = await searchParams;
  const guarantorSearch = typeof search.g === 'string' ? search.g.trim() : '';

  const editable = termsAreEditable(loan.status);
  const canLink = contextCan(context, 'guarantors:link');
  const canCreateGuarantor = contextCan(context, 'guarantors:create');
  const canUpload = contextCan(context, 'loans:documents');
  const canEditDraft = contextCan(context, 'loans:update_draft');

  const [profile, guarantors, documents, terms, product, failures] = await Promise.all([
    getLoanApplicationProfile(loanId),
    getLoanGuarantors(loanId),
    getLoanDocuments(loanId),
    getCurrentConsentTerms(),
    getLoanProduct(loan.productId),
    loan.status === 'draft' || loan.status === 'pending_approval'
      ? loanApprovalFailures(loanId)
      : Promise.resolve([]),
  ]);

  // Only asked for when the picker could actually be used. The function runs
  // under the caller's own policies, so a reader without `clients:view` gets
  // nothing — but not asking at all keeps the intent visible here too.
  const candidates =
    editable && canLink && guarantorSearch !== ''
      ? await searchGuarantorCandidates(loanId, guarantorSearch)
      : [];

  // The stricter of the two, which is the rule `validate_loan_for_approval`
  // applies: the business's floor is what every product sits above, and a
  // product may ask for more.
  const requiredGuarantors = Math.max(
    product?.minGuarantors ?? 0,
    // A product asking for none still inherits the business's floor, which the
    // validator reports through `insufficient_guarantors`. Reading it off the
    // failure list rather than re-querying settings keeps one source.
    Number(
      failures.find((failure) => failure.code === 'insufficient_guarantors')?.detail ?? 0,
    ),
  );

  const profileKind = profile?.applicationProfile ?? 'individual';

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Lending Portfolio"
        icon={ClipboardList}
        back={{ href: `${ROUTES.loans}/${loan.id}`, label: loan.loanNumber }}
        title="Application"
        status={<LoanStatusBadge status={loan.status} />}
        description={
          <>
            {loan.clientName} · {loan.productName}
            <span className="mt-1.5 block">
              {editable
                ? 'Everything here can be changed while the application is a draft. From submission it is evidence of what the decision was made on.'
                : 'This application has been submitted. What is recorded here is what the decision was made on and cannot be changed.'}
            </span>
          </>
        }
      />

      {failures.length > 0 ? (
        <Alert tone="warning">
          <p className="font-medium">This application is not ready for a decision:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {failures.map((failure) => (
              <li key={failure.code}>
                {describeLoanApprovalFailure(failure.code, failure.detail)}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <SectionTabs
        label="Application sections"
        tabs={[
          ...(profileKind === 'salary' || profileKind === 'business'
            ? [{ id: 'product-questions-heading', label: 'Product details' }]
            : []),
          { id: 'guarantors-heading', label: 'Guarantors' },
          { id: 'documents-heading', label: 'Documents' },
        ]}
      />

      {/* --- The product's own questions ---------------------------------- */}
      {profile !== null && (profileKind === 'salary' || profileKind === 'business') ? (
        <section
          aria-labelledby="product-questions-heading"
          className="min-w-0 space-y-3"
        >
          <h2 id="product-questions-heading" className="text-text text-lg font-semibold">
            {profileKind === 'salary' ? 'Employment' : 'The business'}
          </h2>
          <p className="text-text-muted text-sm">
            {profile.productName} asks these questions of every application. The approval
            is refused without them.
          </p>

          <Card>
            {profileKind === 'salary' ? (
              <SalaryDetailsForm
                loanId={loan.id}
                profile={profile}
                editable={editable && canEditDraft}
              />
            ) : (
              <BusinessDetailsForm
                loanId={loan.id}
                profile={profile}
                editable={editable && canEditDraft}
              />
            )}
          </Card>
        </section>
      ) : profileKind === 'quick' ? (
        <section
          aria-labelledby="product-questions-heading"
          className="min-w-0 space-y-3"
        >
          <h2 id="product-questions-heading" className="text-text text-lg font-semibold">
            Product details
          </h2>
          <Card>
            <p className="text-text-muted">
              {loan.productName} is a quick product and asks no further questions. The
              guarantor and approval rules below still apply in full.
            </p>
          </Card>
        </section>
      ) : null}

      {/* --- Guarantors --------------------------------------------------- */}
      <section aria-labelledby="guarantors-heading" className="min-w-0 space-y-3">
        <h2 id="guarantors-heading" className="text-text text-lg font-semibold">
          Guarantors and security
        </h2>
        <p className="text-text-muted text-sm">
          Who agreed to stand behind this loan, and the undertaking each one signed. A
          guarantor captured here appears in the guarantor register immediately.
        </p>

        <LoanGuarantorSection
          loanId={loan.id}
          guarantors={guarantors}
          candidates={candidates}
          searchTerm={guarantorSearch}
          terms={terms}
          editable={editable}
          canLink={canLink}
          canCreate={canCreateGuarantor && canLink}
          requiredCount={requiredGuarantors}
        />

        {product?.collateralRequired === true ? (
          <Alert tone="info">
            {loan.productName} requires collateral. Recording and valuing security is
            Phase 5; until then, note the item and its value in the loan&rsquo;s notes and
            file any paperwork as a supporting document below.
          </Alert>
        ) : null}
      </section>

      {/* --- Documents ---------------------------------------------------- */}
      <section aria-labelledby="documents-heading" className="min-w-0 space-y-3">
        <h2 id="documents-heading" className="text-text text-lg font-semibold">
          Supporting documents
        </h2>
        <p className="text-text-muted text-sm">
          Held in a private bucket. Nothing here is served from a permanent address.
        </p>

        <LoanDocumentsPanel
          loanId={loan.id}
          documents={documents}
          guarantors={guarantors}
          applicationProfile={profileKind}
          editable={editable}
          canUpload={canUpload}
          requiresSupportingDocuments={profile?.requiresSupportingDocuments ?? false}
        />
      </section>
    </div>
  );
}
