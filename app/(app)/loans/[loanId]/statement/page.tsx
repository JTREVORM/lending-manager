import { FileText } from 'lucide-react';

import { notFound } from 'next/navigation';

import { LoanStatementView } from '@/components/reports/loan-statement';
import { PrintButton } from '@/components/reports/print-button';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { getDocumentBranding } from '@/lib/data/company';
import { getLoanStatement } from '@/lib/data/reports';
import { businessToday } from '@/lib/domain/datetime';

export const metadata = { title: 'Loan statement' };

/**
 * A printable loan statement, for staff.
 *
 * ## Guarded by the loan's own capability
 *
 * `loans:view`, like the loan record it restates. A statement is a rendering
 * of a loan, so anybody who may open the loan may print its statement — and
 * Row Level Security decides which loan this is anyway: a caller who cannot
 * read the loan gets `notFound` from the query, not an empty statement.
 *
 * ## Nothing is written
 *
 * Three reads and no writes. Printing a statement for a loan past its grace
 * deadline does not create the charge — the pending charge is described, and
 * the ledger is written by the next transaction that touches the loan. §108.
 */
export default async function LoanStatementPage({
  params,
}: {
  readonly params: Promise<{ readonly loanId: string }>;
}) {
  const { loanId } = await params;

  await guardPermission(`${ROUTES.loans}/${loanId}/statement`, 'loans:view');

  const [statement, branding] = await Promise.all([
    getLoanStatement(loanId),
    getDocumentBranding(),
  ]);

  if (statement === null) notFound();

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        eyebrow="Borrower Document"
        icon={FileText}
        back={{ href: `${ROUTES.loans}/${loanId}`, label: 'Loan' }}
        title="Loan statement"
        description="Where this loan stands, as a document to hand to the borrower."
        secondaryActions={<PrintButton label="Print statement" />}
      />

      <LoanStatementView
        statement={statement}
        audience="staff"
        branding={branding}
        businessDate={businessToday(new Date(), branding.timezone)}
        timeZone={branding.timezone}
      />
    </div>
  );
}
