import { Landmark } from 'lucide-react';

import { IncomeForm } from '@/components/finance/income-form';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { getLedgerAccounts, getPostableAccounts } from '@/lib/data/finance';
import { businessToday } from '@/lib/domain/datetime';

export const metadata = { title: 'Record income' };

export default async function NewIncomePage() {
  await guardPermission(ROUTES.newIncome, 'income:create');

  const [categories, cashAccounts] = await Promise.all([
    getPostableAccounts('income'),
    getLedgerAccounts({ cashOnly: true, activeOnly: true }),
  ]);

  // Interest and Penalty Income are posted by the lending functions from a
  // payment's allocation components. The database refuses them here, so
  // offering them in the picker would be offering a refusal.
  const selectable = categories.filter(
    (category) => category.code !== '4100' && category.code !== '4200',
  );

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        eyebrow="Financial Ledger"
        icon={Landmark}
        title="Record income"
        description="A fee or other income that is not interest or a penalty."
        back={{ href: ROUTES.otherIncome, label: 'Other income' }}
      />

      <IncomeForm
        categories={selectable}
        cashAccounts={cashAccounts}
        today={businessToday()}
      />
    </div>
  );
}
