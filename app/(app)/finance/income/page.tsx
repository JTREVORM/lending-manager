import { Landmark } from 'lucide-react';

import { IncomeRegister } from '@/components/finance/registers';
import { ActionLink, PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { getOtherIncome } from '@/lib/data/finance';

export const metadata = { title: 'Other income' };

/**
 * Fees and income that is not interest or a penalty.
 *
 * Interest and penalty income are deliberately not recordable here: they are
 * written by the lending functions from a payment's own allocation
 * components, and `record_other_income` refuses an account of either kind.
 * Allowing a hand-typed fee into Interest Income would break the Phase 10
 * reconciliation that proves interest income equals interest collected.
 */
export default async function OtherIncomePage() {
  const context = await guardPermission(ROUTES.otherIncome, 'income:view');
  const rows = await getOtherIncome({ limit: 50 });

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        eyebrow="Financial Ledger"
        icon={Landmark}
        title="Other income"
        description="Fees and other income that is not interest or a penalty."
        back={{ href: ROUTES.finance, label: 'Finance' }}
        primaryAction={
          contextCan(context, 'income:create') ? (
            <ActionLink href={ROUTES.newIncome}>Record income</ActionLink>
          ) : undefined
        }
      />

      <IncomeRegister rows={rows} canReverse={contextCan(context, 'income:create')} />

      <p className="text-text-muted text-xs">
        Principal recovered from a borrower is not income — it reduces Loans Receivable.
        Interest and penalties collected are income, and are posted by the payment itself.
      </p>
    </div>
  );
}
