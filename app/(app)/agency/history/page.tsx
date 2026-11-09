import { Receipt } from 'lucide-react';

import { AgencyReadError } from '@/components/agency/read-failure';

import { AgencyTransactionRegister } from '@/components/agency/transaction-register';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { getAgencyTransactions } from '@/lib/data/agency';

export const metadata = { title: 'Transaction history' };

/**
 * Every agency transaction the caller may see.
 *
 * Which rows those are is decided by the view's own row-level policy: the
 * branch the officer belongs to, or every branch for a Head Office profile. A
 * borrower holds no agency capability and is refused the route outright.
 */
export default async function AgencyHistoryPage() {
  await guardPermission(ROUTES.agencyHistory, 'agency:reports');
  const rows = await getAgencyTransactions({ limit: 100 });

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        eyebrow="Agency Banking"
        icon={Receipt}
        title="Transaction history"
        description="Recorded, verified, reversed and cancelled — the whole counter."
        back={{ href: ROUTES.agency, label: 'Agency Services' }}
      />
      {rows.ok ? (
        <AgencyTransactionRegister
          rows={rows.rows}
          caption="Agency transaction history"
          emptyMessage="No agency transaction has been recorded yet."
        />
      ) : (
        <AgencyReadError failure={rows} />
      )}
    </div>
  );
}
