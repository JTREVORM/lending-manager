import { Scale } from 'lucide-react';

import { ReconciliationForm } from '@/components/finance/reconciliation-form';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { getFinanceSettings, getLedgerAccounts } from '@/lib/data/finance';
import { businessToday } from '@/lib/domain/datetime';

export const metadata = { title: 'Record a count' };

export default async function NewReconciliationPage() {
  await guardPermission(ROUTES.newReconciliation, 'reconciliation:perform');

  const [cashAccounts, settings] = await Promise.all([
    getLedgerAccounts({ cashOnly: true, activeOnly: true }),
    getFinanceSettings(),
  ]);

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        eyebrow="Financial Ledger"
        icon={Scale}
        title="Record a count"
        description="What is actually in the drawer, the wallet or the account."
        back={{ href: ROUTES.reconciliation, label: 'Reconciliation' }}
      />

      <ReconciliationForm
        cashAccounts={cashAccounts}
        today={businessToday()}
        requiresReview={settings?.reconciliationRequiresReview ?? true}
      />
    </div>
  );
}
