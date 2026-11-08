import { BadgeCheck } from 'lucide-react';

import { AgencyTransactionRegister } from '@/components/agency/transaction-register';
import { Alert } from '@/components/ui/alert';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { getAgencyTransactions } from '@/lib/data/agency';

export const metadata = { title: 'Pending verification' };

/**
 * What is waiting for a second officer.
 *
 * Everyone with `agency:reports` can see the queue; only a manager can act on
 * it, and never on their own entry. The note below says so to the officer who
 * cannot act, rather than presenting an empty-looking screen.
 */
export default async function AgencyPendingPage() {
  const context = await guardPermission(ROUTES.agencyPending, 'agency:reports');
  const rows = await getAgencyTransactions({
    statuses: ['awaiting_verification', 'returned'],
    limit: 100,
  });

  const canVerify = contextCan(context, 'agency:verify');

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        eyebrow="Agency Banking"
        icon={BadgeCheck}
        title="Pending verification"
        description="Recorded at the counter and waiting for a second officer to post it."
        back={{ href: ROUTES.agency, label: 'Agency Services' }}
      />

      {canVerify ? (
        <Alert tone="info">
          Open a transaction to verify or return it. You cannot verify one you recorded
          yourself — the database refuses it, whoever you are.
        </Alert>
      ) : (
        <Alert tone="info">
          You can see this queue but not act on it: verification is a manager&rsquo;s, and
          it is what writes the journal.
        </Alert>
      )}

      <AgencyTransactionRegister
        rows={rows}
        caption="Agency transactions awaiting verification or returned for correction"
        emptyMessage="Nothing is waiting."
      />
    </div>
  );
}
