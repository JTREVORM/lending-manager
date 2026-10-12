import { ArrowLeftRight } from 'lucide-react';

import { TransferRegister } from '@/components/finance/registers';
import { ActionLink, PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { getTransfers } from '@/lib/data/finance';

export const metadata = { title: 'Transfers' };

/**
 * Transfers between the company's own accounts.
 *
 * A transfer is neither income nor an expense — both legs are assets — so
 * nothing on this page contributes to a profit figure anywhere in the system.
 * That is worth stating because booking a bank deposit as income is the most
 * common error in a hand-kept cash book, and the schema is what makes it
 * unavailable here.
 */
export default async function TransfersPage() {
  const context = await guardPermission(ROUTES.transfers, 'transfers:view');
  const rows = await getTransfers({ limit: 50 });

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        eyebrow="Financial Ledger"
        icon={ArrowLeftRight}
        title="Transfers"
        description="Money moved between Cash at Hand, the two wallets and the bank."
        back={{ href: ROUTES.finance, label: 'Finance' }}
        primaryAction={
          contextCan(context, 'transfers:create') ? (
            <ActionLink href={ROUTES.newTransfer}>New transfer</ActionLink>
          ) : undefined
        }
      />

      <TransferRegister
        rows={rows}
        canDecide={contextCan(context, 'transfers:approve')}
      />
    </div>
  );
}
