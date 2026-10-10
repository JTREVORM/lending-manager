import { Banknote } from 'lucide-react';

import { LoanForm } from '@/components/loans/loan-form';
import { Alert } from '@/components/ui/alert';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { loadLoanFormData } from '@/lib/data/loan-form';

export const metadata = { title: 'New loan' };

/**
 * Start a loan.
 *
 * The client list, the repayment frequencies and the lending settings are all
 * read server-side. None of them is accepted from the browser: the settings in
 * particular decide the minimum amount and which periods are available, and a
 * form that could be told its own rules would be no check at all.
 */
export default async function NewLoanPage() {
  await guardPermission(`${ROUTES.loans}/new`, 'loans:create');

  const data = await loadLoanFormData();

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Lending Portfolio"
        icon={Banknote}
        back={{ href: ROUTES.loans, label: 'Loans' }}
        title="New loan application"
        description={
          'Choose the product first: it decides the amounts, the periods, the rate and what else the application asks for. A loan number is issued when the draft is saved.'
        }
      />

      {data.clients.length === 0 ? (
        <Alert tone="warning">
          There are no clients eligible for a loan. A client must be active, and a client
          with an outstanding loan cannot take another.
        </Alert>
      ) : null}

      {data.products.length === 0 ? (
        <Alert tone="danger">
          No loan product is currently active, so an application cannot be written. An
          Owner or Administrator publishes one from Loan Products.
        </Alert>
      ) : null}

      <LoanForm
        clients={data.clients}
        frequencies={data.frequencies}
        products={data.products}
        settings={data.settings}
      />
    </div>
  );
}
