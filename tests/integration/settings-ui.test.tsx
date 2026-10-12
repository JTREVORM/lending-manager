import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CompanyLogo } from '@/components/brand/company-logo';
import { DocumentLetterhead } from '@/components/brand/document-letterhead';
import { ProductForm } from '@/components/settings/product-form';
import { COMPANY_DEFAULTS } from '@/config/defaults';
import type { LoanProduct } from '@/lib/domain/loan-product';
import { DOCUMENT_BRANDING } from '../helpers/branding';

/**
 * The company's branding, and the product form it is configured from.
 *
 * ## What is worth asserting about branding
 *
 * Not that a particular image renders — that is a file path. What matters is
 * that every surface takes the company from the company record rather than
 * from a constant, that a business with no logo recorded gets a layout that
 * still reads as finished, and that the two documents a borrower takes away
 * carry the same letterhead. Those are the three things that were wrong
 * before Phase 12.
 */
vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/products',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * The Server Action module is stubbed.
 *
 * It is a `'use server'` module reaching `server-only` code, which refuses to
 * load in a client-component graph — correctly, since that guard keeps the
 * secret key out of the browser bundle. What the actions *do* is tested where
 * it is enforced: `tests/db/loan-products.test.ts` drives every rule as a
 * real database role.
 */
vi.mock('@/lib/products/actions', () => ({
  createLoanProductAction: vi.fn(),
  updateLoanProductAction: vi.fn(),
  setLoanProductStatusAction: vi.fn(),
  setDefaultLoanProductAction: vi.fn(),
}));

const PRODUCT: LoanProduct = {
  productId: '11111111-1111-4111-8111-111111111111',
  productCode: 'SL',
  name: 'Salary Loans',
  description: 'For an employed borrower, repaid against a salary.',
  status: 'active',
  sortOrder: 20,
  isDefault: false,
  minAmount: 200_000,
  maxAmount: 20_000_000,
  defaultInterestRateBps: 1_200,
  minInterestRateBps: 1_000,
  maxInterestRateBps: 1_800,
  interestMethod: 'reducing_balance_monthly',
  interestOverrideAllowed: true,
  interestOverrideRoles: ['owner_admin', 'manager'],
  minTermMonths: 1,
  maxTermMonths: 3,
  allowedTermMonths: null,
  allowedRepaymentFrequencies: ['daily', 'every_3_days'],
  defaultRepaymentFrequency: 'every_3_days',
  gracePeriodDays: 5,
  penaltyRateBps: 5_000,
  penaltyMethod: 'one_time_percent_of_outstanding',
  guarantorRequired: true,
  minGuarantors: 1,
  collateralRequired: false,
  earlyRepayment: 'allowed_with_rebate',
  extraPayment: 'reduces_balance',
  applicationProfile: 'salary',
  requiresSupportingDocuments: true,
  branchIds: null,
  loansWritten: 4,
  createdAt: '2026-10-12T00:00:00Z',
  updatedAt: '2026-10-12T00:00:00Z',
};

const CADENCES = [
  { key: 'daily', label: 'Daily', intervalDays: 1 },
  { key: 'every_2_days', label: 'Every 2 days', intervalDays: 2 },
  { key: 'every_3_days', label: 'Every 3 days', intervalDays: 3 },
];

const BRANCHES = [{ id: 'b1', branchCode: 'BR2601', name: 'Head Office' }];

// ===========================================================================
describe('the company mark', () => {
  it('renders the recorded logo with the company as its accessible name', () => {
    render(
      <CompanyLogo
        companyName="Polytos Financial Services Ltd"
        logoPath="brand/x.webp"
      />,
    );

    const image = screen.getByRole('img', { name: 'Polytos Financial Services Ltd' });
    expect(image).toBeInTheDocument();
    // The path is stored without a leading slash; the component adds one.
    expect(image.getAttribute('src')).toMatch(/brand%2Fx\.webp|\/brand\/x\.webp/);
  });

  it('falls back to a monogram rather than to empty space', () => {
    // A blank tile where a logo should be reads as a broken page, and every
    // new deployment has no logo until somebody records one.
    const { container } = render(
      <CompanyLogo companyName="Kampala Credit Ltd" logoPath={null} />,
    );

    expect(screen.queryByRole('img')).toBeNull();
    expect(container.textContent).toBe('KC');
  });

  it('takes the company from the record, never from a constant', () => {
    // The sign-in screen is the one surface that cannot read the row, and its
    // fallback is `config/defaults.ts` — which has to say the same thing the
    // seeded row does, or a borrower sees two different companies.
    expect(COMPANY_DEFAULTS.companyName).toBe('Polytos Financial Services Ltd');
    expect(COMPANY_DEFAULTS.tagline).toBe('Empowering Your Business Swiftly');
    expect(COMPANY_DEFAULTS.phone).toBe('+256768735982');
    expect(COMPANY_DEFAULTS.phoneSecondary).toBe('+256703587676');
    expect(COMPANY_DEFAULTS.postalAddress).toBe('P.O. Box 219933, Kampala');
    expect(COMPANY_DEFAULTS.addressLine1).toBe('Nsumbi, Kyebando');
    expect(COMPANY_DEFAULTS.logoPath).toBe('brand/polytos-logo.webp');
  });
});

// ===========================================================================
describe('a document letterhead', () => {
  it('carries the name, the tagline, both numbers and both addresses', () => {
    render(
      <DocumentLetterhead
        branding={DOCUMENT_BRANDING}
        documentTitle="Payment receipt"
        reference="PAY260001"
      />,
    );

    expect(screen.getByText('Kampala Credit Ltd')).toBeInTheDocument();
    expect(screen.getByText('Lending that moves with you')).toBeInTheDocument();
    expect(screen.getByText('+256700000000 · +256700000001')).toBeInTheDocument();
    expect(screen.getByText('P.O. Box 1234, Kampala')).toBeInTheDocument();
    expect(screen.getByText('Plot 5, Kampala Road, Kampala, Uganda')).toBeInTheDocument();

    // And what the piece of paper is.
    expect(screen.getByText('Payment receipt')).toBeInTheDocument();
    expect(screen.getByText('PAY260001')).toBeInTheDocument();
  });

  it('renders without a tagline, a second number or an address', () => {
    // A business may have none of these, and the letterhead must not print an
    // empty line where each would be.
    render(
      <DocumentLetterhead
        branding={{
          ...DOCUMENT_BRANDING,
          tagline: null,
          phoneSecondary: null,
          postalAddress: null,
          physicalAddress: null,
          receiptHeader: null,
        }}
        documentTitle="Loan statement"
      />,
    );

    expect(screen.getByText('Kampala Credit Ltd')).toBeInTheDocument();
    expect(screen.getByText('+256700000000')).toBeInTheDocument();
    expect(screen.queryByText('Lending that moves with you')).toBeNull();
    expect(screen.queryByText(/·/)).toBeNull();
  });
});

// ===========================================================================
describe('the product form', () => {
  it('says that a change does not reach an existing loan', () => {
    render(<ProductForm product={PRODUCT} branches={BRANCHES} cadences={CADENCES} />);

    // The single most important sentence on the screen: an Owner dropping a
    // rate has to know it applies to loans approved from now on.
    expect(screen.getByText(/does not change an existing loan/i)).toBeInTheDocument();
  });

  it('shows the product as it stands, with rates as percentages', () => {
    render(<ProductForm product={PRODUCT} branches={BRANCHES} cadences={CADENCES} />);

    expect(screen.getByLabelText(/Product name/)).toHaveValue('Salary Loans');
    // Basis points are internal; a person types and reads a percentage.
    expect(screen.getByLabelText(/Standard monthly rate/)).toHaveValue('12');
    expect(screen.getByLabelText(/Lowest permitted rate/)).toHaveValue('10');
    expect(screen.getByLabelText(/Highest permitted rate/)).toHaveValue('18');
    expect(screen.getByLabelText(/Late-payment charge/)).toHaveValue('50');
  });

  it('fixes the product code when editing, because snapshots carry it', () => {
    render(<ProductForm product={PRODUCT} branches={BRANCHES} cadences={CADENCES} />);

    const code = screen.getByLabelText(/Product code/);
    expect(code).toBeDisabled();
    expect(code).toHaveValue('SL');
  });

  it('asks for a code when creating', () => {
    render(<ProductForm branches={BRANCHES} cadences={CADENCES} />);

    expect(screen.getByLabelText(/Product code/)).toBeEnabled();
  });

  it('offers the override roles only while overriding is permitted', () => {
    render(<ProductForm product={PRODUCT} branches={BRANCHES} cadences={CADENCES} />);

    // The product permits it, so the list is there and reflects who may.
    const group = screen.getByRole('group', { name: /Who may approve a different rate/ });
    expect(within(group).getByLabelText(/Owner/)).toBeChecked();
    expect(within(group).getByLabelText(/Secretary/)).not.toBeChecked();

    // A product that does not permit it is not asked who may.
    render(
      <ProductForm
        product={{
          ...PRODUCT,
          interestOverrideAllowed: false,
          interestOverrideRoles: [],
        }}
        branches={BRANCHES}
        cadences={CADENCES}
      />,
    );

    expect(
      screen.getAllByRole('group', { name: /Who may approve a different rate/ }),
    ).toHaveLength(1);
  });

  it('ticks the cadences the product offers and no others', () => {
    render(<ProductForm product={PRODUCT} branches={BRANCHES} cadences={CADENCES} />);

    const group = screen.getByRole('group', { name: /Repayment cadences offered/ });
    expect(within(group).getByLabelText('Daily')).toBeChecked();
    expect(within(group).getByLabelText('Every 2 days')).not.toBeChecked();
    expect(within(group).getByLabelText('Every 3 days')).toBeChecked();
  });

  it('offers no way to delete a product', () => {
    render(<ProductForm product={PRODUCT} branches={BRANCHES} cadences={CADENCES} />);

    // There is no such control because there is no such privilege: a product
    // with loans against it is named by every one of their snapshots.
    expect(screen.queryByRole('button', { name: /delete|remove/i })).toBeNull();
  });
});
