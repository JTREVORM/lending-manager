import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  BusinessDetailsSummary,
  SalaryDetailsForm,
  SalaryDetailsSummary,
} from '@/components/loans/application-details-form';
import { LoanDocumentsPanel } from '@/components/loans/loan-documents-panel';
import { LoanGuarantorSection } from '@/components/loans/loan-guarantor-section';
import { LoanWorkflowTabs } from '@/components/loans/loan-workflow-tabs';
import { LOAN_WORKFLOW_LABELS, LOAN_WORKFLOW_STAGES } from '@/lib/domain/loan';
import type {
  GuarantorCandidate,
  GuarantorConsentTerms,
  LoanApplicationProfile,
  LoanDocument,
  LoanGuarantor,
} from '@/lib/data/loan-application';

/**
 * The Phase 13 application screens.
 *
 * What these can check without a database is the thing that matters most about
 * this part of the system: whether a staff member is told *why* somebody
 * cannot guarantee a loan, whether a guarantor who has not signed is visibly
 * unsigned, and whether an undertaking is shown in full before it is accepted.
 * A guarantor is agreeing to pay somebody else's debt; what makes that
 * enforceable is that they were shown the words.
 */
vi.mock('next/navigation', () => ({
  usePathname: () => '/loans',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/loans/application-actions', () => ({
  saveSalaryDetailsAction: vi.fn(),
  saveBusinessDetailsAction: vi.fn(),
  attachClientGuarantorAction: vi.fn(),
  attachExternalGuarantorAction: vi.fn(),
  removeLoanGuarantorAction: vi.fn(),
  recordGuarantorConsentAction: vi.fn(),
  uploadLoanDocumentAction: vi.fn(),
  removeLoanDocumentAction: vi.fn(),
}));

const LOAN_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

const TERMS: GuarantorConsentTerms = {
  id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
  version: '1.0',
  title: 'Guarantor undertaking',
  body: 'I confirm that I have read and understood this undertaking before signing it. I agree to act as guarantor for the loan described on this application.',
  effectiveFrom: '2026-10-01',
};

function guarantor(overrides: Partial<LoanGuarantor> = {}): LoanGuarantor {
  return {
    id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    loanId: LOAN_ID,
    subjectKind: 'external',
    guarantorId: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e',
    guarantorClientId: null,
    clientNumber: null,
    fullName: 'Nabirye Sarah',
    phone: '+256771234567',
    alternativePhone: null,
    sex: 'female',
    dateOfBirth: '1988-04-12',
    occupation: 'Tailor',
    employerName: 'Self employed',
    location: 'Bweyogerere',
    district: 'Wakiso',
    relationshipToClient: 'Sister',
    consentTermsId: null,
    consentVersion: null,
    consentedAt: null,
    signatureName: null,
    witnessName: null,
    witnessPhone: null,
    consentPlace: null,
    consentSigned: false,
    hasIdentification: true,
    hasSignatureImage: false,
    hasPhotograph: true,
    evidenceFrozen: false,
    documentCount: 0,
    createdAt: '2026-10-01T08:00:00Z',
    ...overrides,
  };
}

function candidate(overrides: Partial<GuarantorCandidate> = {}): GuarantorCandidate {
  return {
    clientId: '3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f',
    clientNumber: 'CL26007',
    fullName: 'Okello Joseph',
    phone: '+256700111222',
    occupation: 'Boda rider',
    location: 'Kawempe',
    district: 'Kampala',
    status: 'active',
    hasIdentification: true,
    activeLoanCount: 0,
    arrearsAmount: 0,
    guaranteeingCount: 0,
    alreadyAttached: false,
    eligible: true,
    reasons: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
describe('the loan workflow strip', () => {
  it('offers every view the loan module presents, plus the whole register', () => {
    render(<LoanWorkflowTabs stage="" />);

    for (const value of LOAN_WORKFLOW_STAGES) {
      expect(screen.getByText(LOAN_WORKFLOW_LABELS[value])).toBeTruthy();
    }

    expect(screen.getByText('All loans')).toBeTruthy();
  });

  it('marks the view that is open', () => {
    render(<LoanWorkflowTabs stage="arrears" />);

    const current = screen.getByText(LOAN_WORKFLOW_LABELS.arrears);
    expect(current.getAttribute('aria-current')).toBe('page');

    expect(screen.getByText('All loans').getAttribute('aria-current')).toBeNull();
  });

  it('separates a rejection from a cancellation', () => {
    // The whole reason Phase 13 added a closure kind: a refusal is a credit
    // decision and a withdrawal is a change of mind, and only the first
    // belongs in a report about lending standards.
    render(<LoanWorkflowTabs stage="" />);

    expect(screen.getByText('Rejected')).toBeTruthy();
    expect(screen.getByText('Cancelled')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
describe('guarantors on an application', () => {
  it('says how many are still needed', () => {
    render(
      <LoanGuarantorSection
        loanId={LOAN_ID}
        guarantors={[]}
        candidates={[]}
        searchTerm=""
        terms={TERMS}
        editable
        canLink
        canCreate
        requiredCount={2}
      />,
    );

    expect(screen.getByText(/needs 2 guarantors and has none/i)).toBeTruthy();
  });

  it('warns that an unsigned undertaking blocks the approval', () => {
    render(
      <LoanGuarantorSection
        loanId={LOAN_ID}
        guarantors={[guarantor()]}
        candidates={[]}
        searchTerm=""
        terms={TERMS}
        editable
        canLink
        canCreate
        requiredCount={1}
      />,
    );

    expect(screen.getByText(/has not signed the undertaking/i)).toBeTruthy();
    expect(screen.getAllByText('Not signed').length).toBeGreaterThan(0);
  });

  it('shows the version, the signatory and the witness once it is signed', () => {
    render(
      <LoanGuarantorSection
        loanId={LOAN_ID}
        guarantors={[
          guarantor({
            consentSigned: true,
            consentVersion: '1.0',
            consentedAt: '2026-10-02T09:15:00Z',
            signatureName: 'Nabirye Sarah',
            witnessName: 'Opio Daniel',
          }),
        ]}
        candidates={[]}
        searchTerm=""
        terms={TERMS}
        editable
        canLink
        canCreate
        requiredCount={1}
      />,
    );

    expect(screen.getByText('Undertaking version 1.0')).toBeTruthy();
    expect(screen.getByText('Opio Daniel')).toBeTruthy();
    expect(
      screen.getByText(/Publishing a new version does not change what this guarantor/i),
    ).toBeTruthy();
  });

  it('distinguishes an existing client from somebody new', () => {
    render(
      <LoanGuarantorSection
        loanId={LOAN_ID}
        guarantors={[
          guarantor({
            subjectKind: 'client',
            guarantorId: null,
            guarantorClientId: '4d5e6f7a-8b9c-4d0e-8f1a-2b3c4d5e6f7a',
            clientNumber: 'CL26009',
          }),
        ]}
        candidates={[]}
        searchTerm=""
        terms={TERMS}
        editable
        canLink
        canCreate
        requiredCount={1}
      />,
    );

    expect(screen.getByText('Existing client')).toBeTruthy();
    expect(screen.getByText(/CL26009/)).toBeTruthy();
  });

  it('says when a guarantor has no identification on file', () => {
    render(
      <LoanGuarantorSection
        loanId={LOAN_ID}
        guarantors={[guarantor({ hasIdentification: false })]}
        candidates={[]}
        searchTerm=""
        terms={TERMS}
        editable
        canLink
        canCreate
        requiredCount={1}
      />,
    );

    expect(screen.getByText('No — approval will be refused')).toBeTruthy();
  });

  it('offers no controls once the application has left draft', () => {
    render(
      <LoanGuarantorSection
        loanId={LOAN_ID}
        guarantors={[guarantor()]}
        candidates={[]}
        searchTerm=""
        terms={TERMS}
        editable={false}
        canLink
        canCreate
        requiredCount={1}
      />,
    );

    expect(screen.queryByText('Add a guarantor')).toBeNull();
    expect(screen.queryByText('Take the undertaking')).toBeNull();
  });

  it('offers both routes to adding one', () => {
    render(
      <LoanGuarantorSection
        loanId={LOAN_ID}
        guarantors={[]}
        candidates={[]}
        searchTerm=""
        terms={TERMS}
        editable
        canLink
        canCreate
        requiredCount={1}
      />,
    );

    expect(screen.getByText('Search existing clients')).toBeTruthy();
    expect(screen.getByText('Capture a new guarantor')).toBeTruthy();
    expect(
      screen.getByText(/appears in the guarantor register straight away/i),
    ).toBeTruthy();
  });

  it('hides the capture route from somebody who may not register a guarantor', () => {
    render(
      <LoanGuarantorSection
        loanId={LOAN_ID}
        guarantors={[]}
        candidates={[]}
        searchTerm=""
        terms={TERMS}
        editable
        canLink
        canCreate={false}
        requiredCount={1}
      />,
    );

    expect(screen.getByText('Search existing clients')).toBeTruthy();
    expect(screen.queryByText('Capture a new guarantor')).toBeNull();
  });

  it('refuses to offer a consent when no undertaking is published', () => {
    // A signature against no terms is evidence of nothing.
    render(
      <LoanGuarantorSection
        loanId={LOAN_ID}
        guarantors={[guarantor()]}
        candidates={[]}
        searchTerm=""
        terms={null}
        editable
        canLink
        canCreate
        requiredCount={1}
      />,
    );

    expect(
      screen.getByText(/No guarantor undertaking is currently published/i),
    ).toBeTruthy();
    expect(screen.queryByText('Take the undertaking')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('choosing an existing client as guarantor', () => {
  function renderPicker(candidates: readonly GuarantorCandidate[]) {
    return render(
      <LoanGuarantorSection
        loanId={LOAN_ID}
        guarantors={[]}
        candidates={candidates}
        searchTerm="Okello"
        terms={TERMS}
        editable
        canLink
        canCreate
        requiredCount={1}
      />,
    );
  }

  it('opens itself when a search is already in the URL', () => {
    // Searching the register is a GET form, which navigates. A panel whose
    // openness lived only in component state closed itself on the way back
    // with the results in it — found by a browser test searching for a
    // client.
    renderPicker([candidate()]);

    expect(screen.getByLabelText('Search the client register')).toBeTruthy();
    expect(screen.getByText('Okello Joseph')).toBeTruthy();
  });

  it('lists an ineligible candidate with the reason rather than hiding them', () => {
    // "Mysteriously absent" sends a staff member looking for somebody
    // standing in front of them.
    renderPicker([
      candidate({
        eligible: false,
        reasons: ['has_active_loan', 'in_arrears'],
        activeLoanCount: 1,
      }),
    ]);

    expect(screen.getByText('Okello Joseph')).toBeTruthy();
    expect(screen.getByText(/Has an outstanding loan of their own/i)).toBeTruthy();
    expect(screen.getByText(/Behind on their own repayments/i)).toBeTruthy();

    // Listed, and not selectable: the trigger would refuse the write, so the
    // screen does not offer it.
    const radio = screen.getByRole('radio');
    expect(radio.hasAttribute('disabled')).toBe(true);
  });

  it('offers an eligible candidate, and says so', () => {
    renderPicker([candidate()]);

    expect(screen.getByText(/Eligible to guarantee this loan/i)).toBeTruthy();
    expect(screen.getByRole('radio').hasAttribute('disabled')).toBe(false);
  });

  it('shows the client number and phone, which is what staff search by', () => {
    renderPicker([candidate()]);

    expect(screen.getByText(/CL26007/)).toBeTruthy();
    expect(screen.getByText(/\+256700111222/)).toBeTruthy();
  });

  it('closes the picker when there is no search to show', () => {
    render(
      <LoanGuarantorSection
        loanId={LOAN_ID}
        guarantors={[]}
        candidates={[]}
        searchTerm=""
        terms={TERMS}
        editable
        canLink
        canCreate
        requiredCount={1}
      />,
    );

    // A candidate list rendered behind a closed panel would be a list a
    // screen reader announces and nobody asked for.
    expect(screen.getByText('Search existing clients')).toBeTruthy();
    expect(screen.queryByLabelText('Search the client register')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('the questions a product asks', () => {
  const SALARY_PROFILE: LoanApplicationProfile = {
    loanId: LOAN_ID,
    loanNumber: 'LN260001',
    status: 'pending_approval',
    productCode: 'SL',
    productName: 'Salary Loan',
    applicationProfile: 'salary',
    requiresSupportingDocuments: true,
    detailsPresent: true,
    collateralRequired: false,
    minGuarantors: 1,
    documentCount: 2,
    salary: {
      employerName: 'Mukwano Industries',
      employerContact: '+256700111222',
      jobTitle: 'Machine operator',
      staffNumber: 'MI-4471',
      netMonthlySalary: 850_000,
      salaryPayDay: 28,
      employmentStartedOn: '2022-03-01',
      employmentStatus: 'permanent',
      salaryVerification: 'payslip_seen',
      hasPayslip: true,
      hasEmploymentLetter: false,
    },
    business: null,
  };

  it('reads back the employment once the application is submitted', () => {
    render(<SalaryDetailsSummary profile={SALARY_PROFILE} />);

    expect(screen.getByText('Mukwano Industries')).toBeTruthy();
    expect(screen.getByText('Machine operator')).toBeTruthy();
    expect(screen.getByText('Day 28 of the month')).toBeTruthy();
    expect(screen.getByText('Payslip seen')).toBeTruthy();
    expect(screen.getByText('Payslip')).toBeTruthy();
  });

  it('warns when a salary product has no employment recorded', () => {
    render(<SalaryDetailsSummary profile={{ ...SALARY_PROFILE, salary: null }} />);

    expect(screen.getByText(/approval will be refused until they are/i)).toBeTruthy();
  });

  it('offers the form while the application is a draft', () => {
    render(
      <SalaryDetailsForm
        loanId={LOAN_ID}
        profile={{ ...SALARY_PROFILE, status: 'draft' }}
        editable
      />,
    );

    expect(screen.getByLabelText(/Employer name/)).toBeTruthy();
    expect(screen.getByLabelText(/Salary payment day/)).toBeTruthy();
    expect(screen.getByText('Save employment details')).toBeTruthy();
  });

  it('reads back rather than offering a form once it has left draft', () => {
    render(
      <SalaryDetailsForm loanId={LOAN_ID} profile={SALARY_PROFILE} editable={false} />,
    );

    expect(screen.queryByLabelText(/Employer name/)).toBeNull();
    expect(screen.getByText('Mukwano Industries')).toBeTruthy();
  });

  it('shows what a business turns over and what it spends', () => {
    render(
      <BusinessDetailsSummary
        profile={{
          ...SALARY_PROFILE,
          productName: 'Business Loan',
          applicationProfile: 'business',
          salary: null,
          business: {
            businessName: 'Kalerwe Produce Stall',
            businessType: 'Produce retail',
            businessLocation: 'Kalerwe market',
            businessContact: null,
            tradingSince: '2019-06-01',
            monthlyTurnover: 2_400_000,
            monthlyExpenses: 1_600_000,
            employeeCount: 2,
            premisesOwnership: 'rented',
            tradingLicenceNumber: 'KCCA-99812',
            loanPurpose: 'Buy stock ahead of the school term',
            hasTradingLicence: true,
            hasBankStatement: false,
          },
        }}
      />,
    );

    expect(screen.getByText('Kalerwe Produce Stall')).toBeTruthy();
    expect(screen.getByText('UGX 2,400,000')).toBeTruthy();
    expect(screen.getByText('UGX 1,600,000')).toBeTruthy();
    expect(screen.getByText('Buy stock ahead of the school term')).toBeTruthy();
    expect(screen.getByText('Rented')).toBeTruthy();
  });

  it('shows an em dash for expenses nobody counted, never a zero', () => {
    render(
      <BusinessDetailsSummary
        profile={{
          ...SALARY_PROFILE,
          applicationProfile: 'business',
          salary: null,
          business: {
            businessName: 'Kalerwe Produce Stall',
            businessType: 'Produce retail',
            businessLocation: 'Kalerwe market',
            businessContact: null,
            tradingSince: null,
            monthlyTurnover: 2_400_000,
            monthlyExpenses: null,
            employeeCount: null,
            premisesOwnership: null,
            tradingLicenceNumber: null,
            loanPurpose: 'Buy stock ahead of the school term',
            hasTradingLicence: false,
            hasBankStatement: false,
          },
        }}
      />,
    );

    // A zero would read as "this business has no costs", which is a claim
    // nobody made.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe('the documents filed with an application', () => {
  function document(overrides: Partial<LoanDocument> = {}): LoanDocument {
    return {
      id: '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b',
      loanId: LOAN_ID,
      loanGuarantorId: null,
      kind: 'payslip',
      storagePath: `loans/${LOAN_ID}/payslip/${'a1'.repeat(16)}.pdf`,
      label: 'September payslip',
      contentType: 'application/pdf',
      byteSize: 48_000,
      createdAt: '2026-10-02T09:00:00Z',
      ...overrides,
    };
  }

  it('names each document by kind and description', () => {
    render(
      <LoanDocumentsPanel
        loanId={LOAN_ID}
        documents={[document()]}
        guarantors={[]}
        applicationProfile="salary"
        editable
        canUpload
        requiresSupportingDocuments
      />,
    );

    expect(screen.getAllByText('Payslip').length).toBeGreaterThan(0);
    expect(screen.getByText(/September payslip/)).toBeTruthy();
  });

  it('exposes no address for a stored file', () => {
    // A permanent URL is a credential: once it exists, anyone it is forwarded
    // to can read the document indefinitely, with no record and no revocation.
    const { container } = render(
      <LoanDocumentsPanel
        loanId={LOAN_ID}
        documents={[document()]}
        guarantors={[]}
        applicationProfile="salary"
        editable
        canUpload
        requiresSupportingDocuments
      />,
    );

    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).not.toContain('a1a1a1');
  });

  it('offers the kinds a salary product actually files', () => {
    render(
      <LoanDocumentsPanel
        loanId={LOAN_ID}
        documents={[]}
        guarantors={[]}
        applicationProfile="salary"
        editable
        canUpload
        requiresSupportingDocuments={false}
      />,
    );

    const select = screen.getByLabelText(/What is it/);
    const labels = within(select)
      .getAllByRole('option')
      .map((option) => option.textContent);

    expect(labels).toContain('Payslip');
    expect(labels).toContain('Employment letter');
    expect(labels).not.toContain('Trading licence');
  });

  it('offers the kinds a business product actually files', () => {
    render(
      <LoanDocumentsPanel
        loanId={LOAN_ID}
        documents={[]}
        guarantors={[]}
        applicationProfile="business"
        editable
        canUpload
        requiresSupportingDocuments={false}
      />,
    );

    const labels = within(screen.getByLabelText(/What is it/))
      .getAllByRole('option')
      .map((option) => option.textContent);

    expect(labels).toContain('Trading licence');
    expect(labels).toContain('Bank statement');
    expect(labels).not.toContain('Payslip');
  });

  it('offers the guarantor kinds only when there is a guarantor to file them against', () => {
    render(
      <LoanDocumentsPanel
        loanId={LOAN_ID}
        documents={[]}
        guarantors={[guarantor()]}
        applicationProfile="quick"
        editable
        canUpload
        requiresSupportingDocuments={false}
      />,
    );

    const labels = within(screen.getByLabelText(/What is it/))
      .getAllByRole('option')
      .map((option) => option.textContent);

    expect(labels).toContain('Guarantor signature');
    expect(labels).toContain('Guarantor identification');
  });

  it('offers no upload once the application has left draft', () => {
    render(
      <LoanDocumentsPanel
        loanId={LOAN_ID}
        documents={[document()]}
        guarantors={[]}
        applicationProfile="salary"
        editable={false}
        canUpload
        requiresSupportingDocuments={false}
      />,
    );

    expect(screen.queryByText('File a document')).toBeNull();
    expect(screen.queryByText('Remove')).toBeNull();
  });

  it('offers no upload to somebody without the capability', () => {
    render(
      <LoanDocumentsPanel
        loanId={LOAN_ID}
        documents={[]}
        guarantors={[]}
        applicationProfile="salary"
        editable
        canUpload={false}
        requiresSupportingDocuments={false}
      />,
    );

    expect(screen.queryByText('File a document')).toBeNull();
  });

  it('says when a product expects documents and none are filed', () => {
    render(
      <LoanDocumentsPanel
        loanId={LOAN_ID}
        documents={[]}
        guarantors={[]}
        applicationProfile="business"
        editable
        canUpload
        requiresSupportingDocuments
      />,
    );

    expect(screen.getByText(/expects supporting documents/i)).toBeTruthy();
  });
});
