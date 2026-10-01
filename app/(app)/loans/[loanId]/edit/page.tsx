import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { LoanForm } from '@/components/loans/loan-form';
import { Alert } from '@/components/ui/alert';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { getLoan } from '@/lib/data/loans';
import { loadLoanFormData } from '@/lib/data/loan-form';
import { termsAreEditable } from '@/lib/domain/loan';

export const metadata = { title: 'Edit loan draft' };

/**
 * Edit a draft.
 *
 * A loan that has left draft is not editable, and this page sends the viewer
 * back to the loan rather than showing a form whose every submission would be
 * refused. The database refuses it regardless — that is the guarantee — but a
 * form that cannot work should not be offered.
 */
export default async function EditLoanPage({
  params,
}: {
  readonly params: Promise<{ readonly loanId: string }>;
}) {
  const { loanId } = await params;
  await guardPermission(`${ROUTES.loans}/${loanId}/edit`, 'loans:update_draft');

  const loan = await getLoan(loanId);

  if (loan === null) notFound();

  if (!termsAreEditable(loan.status)) {
    redirect(`${ROUTES.loans}/${loanId}`);
  }

  const data = await loadLoanFormData();

  return (
    <div className="min-w-0 space-y-6">
      <div className="min-w-0">
        <Link
          href={`${ROUTES.loans}/${loan.id}`}
          className="text-accent focus-visible:outline-accent text-sm underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          ← {loan.loanNumber}
        </Link>
        <h1 className="text-text mt-2 text-2xl font-semibold break-words">
          Edit draft {loan.loanNumber}
        </h1>
      </div>

      {loan.reviewNote !== null ? (
        <Alert tone="warning">
          <span className="font-medium">Returned for correction:</span> {loan.reviewNote}
        </Alert>
      ) : null}

      <LoanForm
        loan={loan}
        clients={data.clients}
        frequencies={data.frequencies}
        settings={data.settings}
      />
    </div>
  );
}
