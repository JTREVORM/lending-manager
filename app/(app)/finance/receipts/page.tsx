import { HandCoins } from 'lucide-react';

import { CashAvailability } from '@/components/finance/cash-availability';
import { ReceiptConfirmation } from '@/components/finance/receipt-confirmation';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { getCashAvailability, getPendingReceipts } from '@/lib/data/finance';

export const metadata = { title: 'Cash received' };

/**
 * What has been taken in, and what may be spent.
 *
 * Two figures that used to be one. A receipt counts for the borrower the
 * moment it is recorded — their arrears fall, their deadline moves — and
 * counts for the company only once a second person has looked in the drawer
 * and said the money is there. Until then the ledger holds it and the
 * business may not pay it out.
 *
 * The screen says both, side by side, because a cashier who sees only the
 * booked balance will plan a disbursement the database is going to refuse.
 */
export default async function ReceiptsPage() {
  const context = await guardPermission(ROUTES.receipts, 'receipts:view');

  const [availability, pending] = await Promise.all([
    getCashAvailability(),
    getPendingReceipts(),
  ]);

  return (
    <>
      <PageHeader
        icon={HandCoins}
        eyebrow="Finance"
        title="Cash received"
        description="Money recorded at the counter, and whether a second officer has counted it yet. Until it is counted, the business cannot spend it."
      />

      <CashAvailability accounts={availability} className="mt-6" />

      <ReceiptConfirmation
        receipts={pending}
        canConfirm={contextCan(context, 'receipts:confirm')}
        className="mt-8"
      />
    </>
  );
}
