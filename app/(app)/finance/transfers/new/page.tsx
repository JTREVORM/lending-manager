import { ArrowLeftRight } from 'lucide-react';

import { TransferForm } from '@/components/finance/transfer-form';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { getFinanceSettings, getLedgerAccounts } from '@/lib/data/finance';
import { businessToday } from '@/lib/domain/datetime';

export const metadata = { title: 'New transfer' };

export default async function NewTransferPage() {
  await guardPermission(ROUTES.newTransfer, 'transfers:create');

  const [accounts, settings] = await Promise.all([
    getLedgerAccounts({ cashOnly: true, activeOnly: true }),
    getFinanceSettings(),
  ]);

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        eyebrow="Financial Ledger"
        icon={ArrowLeftRight}
        title="New transfer"
        description="Move money between the company’s own accounts."
        back={{ href: ROUTES.transfers, label: 'Transfers' }}
      />

      <TransferForm
        accounts={accounts}
        today={businessToday()}
        approvalThreshold={settings?.transferApprovalThreshold ?? null}
        allowNegativeCash={settings?.allowNegativeCash ?? false}
      />
    </div>
  );
}
