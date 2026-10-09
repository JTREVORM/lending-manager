import type { DocumentBranding } from '@/lib/data/company';

/**
 * The company, for a component test that renders a document.
 *
 * Deliberately **not** Polytos. These tests assert that a receipt and a
 * statement render whatever the company record says, and a fixture carrying
 * the real client's details would pass just as well against a component that
 * had the name written into it. A made-up lender cannot.
 *
 * Every field is populated, including the ones that are nullable in the
 * database, because the letterhead's layout is the thing under test and a
 * fixture full of nulls would exercise only its empty state. The tests that
 * care about absence pass their own overrides.
 */
export const DOCUMENT_BRANDING: DocumentBranding = {
  companyName: 'Kampala Credit Ltd',
  tagline: 'Lending that moves with you',
  logoPath: null,
  phone: '+256700000000',
  phoneSecondary: '+256700000001',
  postalAddress: 'P.O. Box 1234, Kampala',
  physicalAddress: 'Plot 5, Kampala Road, Kampala, Uganda',
  receiptHeader: 'Thank you for your business',
  receiptFooter: 'Keep this receipt safe',
  timezone: 'Africa/Kampala',
};
