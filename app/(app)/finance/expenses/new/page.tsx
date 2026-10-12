import { Receipt } from 'lucide-react';

import { ExpenseForm } from '@/components/finance/expense-form';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import {
  getFinanceSettings,
  getLedgerAccounts,
  getPostableAccounts,
} from '@/lib/data/finance';
import { businessToday } from '@/lib/domain/datetime';

export const metadata = { title: 'Record expense' };

export default async function NewExpensePage() {
  await guardPermission(ROUTES.newExpense, 'expenses:create');

  const [categories, cashAccounts, settings] = await Promise.all([
    getPostableAccounts('expense'),
    getLedgerAccounts({ cashOnly: true, activeOnly: true }),
    getFinanceSettings(),
  ]);

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        eyebrow="Financial Ledger"
        icon={Receipt}
        title="Record expense"
        description="What was spent, on what, and out of which account."
        back={{ href: ROUTES.expenses, label: 'Expenses' }}
      />

      <ExpenseForm
        categories={categories}
        cashAccounts={cashAccounts}
        today={businessToday()}
        approvalThreshold={settings?.expenseApprovalThreshold ?? null}
        allowNegativeCash={settings?.allowNegativeCash ?? false}
      />
    </div>
  );
}
