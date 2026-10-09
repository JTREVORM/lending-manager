import { CompanyLogo } from '@/components/brand/company-logo';
import type { DocumentBranding } from '@/lib/data/company';

/**
 * The head of a document the business hands to a borrower.
 *
 * ## Why this is one component and not markup on each page
 *
 * A receipt and a loan statement are the two things a borrower takes away,
 * and before Phase 12 each built its own header: the receipt showed the name
 * and one phone number, the statement showed the name alone. Same lender, two
 * letterheads, neither carrying the logo or the address. A borrower comparing
 * them cannot tell they came from the same office, and neither can a court.
 *
 * So the letterhead is the company's identity rendered once: the mark, the
 * registered trading name, the tagline beneath it, both published numbers,
 * the P.O. Box and the office address. Everything comes from
 * `company_settings` through `DocumentBranding` — nothing here is written
 * into the component, so a business that moves premises changes a row.
 *
 * ## Why it prints
 *
 * The receipt and the statement are both printed, and a print stylesheet that
 * dropped the logo would produce a slip with no evidence of who issued it.
 * The layout is plain block flow with no shadows or background washes, which
 * is what survives a browser's print renderer intact.
 *
 * ## What it is not
 *
 * Not for operational screens. The brief is explicit that the logo must not
 * crowd the workspace, and a loan register with a letterhead above it is a
 * worse register. The mark appears in the sidebar's brand block, on sign-in,
 * on the settings screen and on documents — nowhere else.
 */
export function DocumentLetterhead({
  branding,
  documentTitle,
  reference,
}: {
  readonly branding: DocumentBranding;
  /** "Payment receipt", "Loan statement" — what this piece of paper is. */
  readonly documentTitle: string;
  /** The document's own number, where it has one. */
  readonly reference?: string;
}) {
  const contacts = [branding.phone, branding.phoneSecondary].filter(
    (part): part is string => part !== null && part.trim() !== '',
  );

  const addresses = [branding.postalAddress, branding.physicalAddress].filter(
    (part): part is string => part !== null && part.trim() !== '',
  );

  return (
    <header className="border-border mb-4 border-b pb-3">
      <div className="flex min-w-0 items-start gap-3">
        <CompanyLogo
          companyName={branding.companyName}
          logoPath={branding.logoPath}
          size="document"
          className="border-border border"
        />

        <div className="min-w-0 flex-1">
          <h2 className="text-text text-base font-bold break-words">
            {branding.companyName}
          </h2>

          {branding.tagline === null ? null : (
            <p className="text-text-muted text-xs italic">{branding.tagline}</p>
          )}

          {contacts.length === 0 ? null : (
            <p className="text-text-muted mt-1 text-xs">{contacts.join(' · ')}</p>
          )}

          {addresses.map((line) => (
            <p key={line} className="text-text-muted text-xs">
              {line}
            </p>
          ))}
        </div>
      </div>

      {/* What the document is, and which one it is. Centred under the
          letterhead, the way a printed form reads: the issuer at the top
          left, the document's own title across the page. */}
      <div className="mt-3 text-center">
        <p className="text-text text-sm font-semibold tracking-wide uppercase">
          {documentTitle}
        </p>
        {reference === undefined ? null : (
          <p className="text-text-muted font-mono text-xs">{reference}</p>
        )}
        {branding.receiptHeader === null ? null : (
          <p className="text-text-muted mt-1 text-xs break-words">
            {branding.receiptHeader}
          </p>
        )}
      </div>
    </header>
  );
}
