import Link from 'next/link';

import { LoanForm } from '@/components/loans/loan-form';
import { Alert } from '@/components/ui/alert';
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
      <div className="min-w-0">
        <Link
          href={ROUTES.loans}
          className="text-accent focus-visible:outline-accent text-sm underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          ← Loans
        </Link>
        <h1 className="text-text mt-2 text-2xl font-semibold break-words">
          Start a loan
        </h1>
        <p className="text-text-muted mt-1">
          A loan number is issued when the draft is saved. The amounts are recorded when
          the loan is approved.
        </p>
      </div>

      {data.clients.length === 0 ? (
        <Alert tone="warning">
          There are no clients eligible for a loan. A client must be active, and a client
          with an outstanding loan cannot take another.
        </Alert>
      ) : null}

      <LoanForm
        clients={data.clients}
        frequencies={data.frequencies}
        settings={data.settings}
      />
    </div>
  );
}
