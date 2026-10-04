import Link from 'next/link';

import { notFound } from 'next/navigation';

import { LoanStatementView } from '@/components/reports/loan-statement';
import { PrintButton } from '@/components/reports/print-button';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { getOwnClientRecord } from '@/lib/data/clients';
import { getCompanyBranding } from '@/lib/data/company';
import { getLoanStatement } from '@/lib/data/reports';
import { businessToday } from '@/lib/domain/datetime';

export const metadata = { title: 'My loan' };

/**
 * A borrower's own loan statement.
 *
 * ## Two checks, and the second is the one that matters
 *
 * `portal:view` gets them into the portal. Whether *this* loan is theirs is
 * decided by Row Level Security: the policy on `loans` admits a borrower's own
 * loans through the ownership clause, so a borrower who edits the loan id in
 * the URL gets nothing back and the page answers `notFound`. The explicit
 * client check below is a second, cheaper layer that makes the intent obvious
 * in the code — it is not what stops the attack, and it is written here so
 * nobody later mistakes it for the whole control.
 *
 * ## No staff attribution, no internal notes
 *
 * `audience="client"` removes who recorded each payment and the links into the
 * staff register. Internal remarks are not on this page for anybody. A
 * borrower sees their agreement, their plan, their payments and their balance.
 */
export default async function PortalLoanPage({
  params,
}: {
  readonly params: Promise<{ readonly loanId: string }>;
}) {
  const { loanId } = await params;
  const context = await guardPermission(
    `${ROUTES.portal}/loans/${loanId}`,
    'portal:view',
  );

  const [statement, { branding }, client] = await Promise.all([
    getLoanStatement(loanId),
    getCompanyBranding(),
    getOwnClientRecord(context.profileId),
  ]);

  if (statement === null) notFound();
  if (statement.loan.clientId !== client?.id) notFound();

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Link href={ROUTES.portal} className="text-brand-700 text-sm hover:underline">
          Back to my account
        </Link>
        <PrintButton label="Print statement" />
      </div>

      <LoanStatementView
        statement={statement}
        audience="client"
        companyName={branding.companyName}
        businessDate={businessToday(new Date(), branding.timezone)}
        timeZone={branding.timezone}
      />
    </div>
  );
}
