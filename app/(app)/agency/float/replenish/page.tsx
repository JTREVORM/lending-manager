import { PiggyBank } from 'lucide-react';

import { FloatReplenishmentForm } from '@/components/agency/settlement-forms';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { getPostableFloatTills } from '@/lib/data/agency';
import { getLedgerAccounts } from '@/lib/data/finance';

export const metadata = { title: 'Top up a float till' };

export default async function ReplenishFloatPage() {
  await guardPermission(ROUTES.agencyReplenish, 'agency:settlements');

  const [tills, accounts] = await Promise.all([
    getPostableFloatTills(),
    getLedgerAccounts({ cashOnly: true, activeOnly: true }),
  ]);

  // Cash at hand and bank only. The database refuses an agency float account
  // and the two mobile money wallets as a funding source — offering one here
  // would be offering a refusal.
  const funding = accounts
    .filter((a) => a.cashKind === 'cash_at_hand' || a.cashKind === 'bank')
    .map((a) => ({
      accountId: a.accountId,
      code: a.code,
      name: a.name,
      branchId: a.branchId,
    }));

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        eyebrow="Agency Banking"
        icon={PiggyBank}
        title="Top up a float till"
        description="Move the business's own money into a provider's electronic float."
        back={{ href: ROUTES.agencyFloat, label: 'Float and tills' }}
      />
      <FloatReplenishmentForm tills={tills} accounts={funding} />
    </div>
  );
}
