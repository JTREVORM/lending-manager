import { Banknote } from 'lucide-react';

import { notFound, redirect } from 'next/navigation';

import { LoanForm } from '@/components/loans/loan-form';
import { Alert } from '@/components/ui/alert';
import { PageHeader } from '@/components/ui/page-header';
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
      <PageHeader
        eyebrow="Lending Portfolio"
        icon={Banknote}
        back={{ href: `${ROUTES.loans}/${loan.id}`, label: loan.loanNumber }}
        title={`Edit draft ${loan.loanNumber}`}
      />

      {loan.reviewNote !== null ? (
        <Alert tone="warning">
          <span className="font-medium">Returned for correction:</span> {loan.reviewNote}
        </Alert>
      ) : null}

      <LoanForm
        loan={loan}
        clients={data.clients}
        frequencies={data.frequencies}
        products={data.products}
        settings={data.settings}
      />
    </div>
  );
}
