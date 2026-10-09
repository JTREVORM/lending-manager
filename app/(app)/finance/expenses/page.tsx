import { Receipt } from 'lucide-react';

import { ExpenseRegister } from '@/components/finance/registers';
import { ActionLink, PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { getExpenses } from '@/lib/data/finance';

export const metadata = { title: 'Expenses' };

export default async function ExpensesPage() {
  const context = await guardPermission(ROUTES.expenses, 'expenses:view');
  const rows = await getExpenses({ limit: 50 });

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        eyebrow="Financial Ledger"
        icon={Receipt}
        title="Expenses"
        description="What the business spent, and out of which account."
        back={{ href: ROUTES.finance, label: 'Finance' }}
        primaryAction={
          contextCan(context, 'expenses:create') ? (
            <ActionLink href={ROUTES.newExpense}>Record expense</ActionLink>
          ) : undefined
        }
      />

      <ExpenseRegister rows={rows} canDecide={contextCan(context, 'expenses:approve')} />

      <p className="text-text-muted text-xs">
        Loan principal is never an expense. Paying out a loan moves an asset — it does not
        consume one — so it debits Loans Receivable and appears nowhere on this page.
      </p>
    </div>
  );
}
