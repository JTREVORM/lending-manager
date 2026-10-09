import { Scale } from 'lucide-react';

import { ReconciliationRegister } from '@/components/finance/registers';
import { ActionLink, PageHeader } from '@/components/ui/page-header';
import { Alert } from '@/components/ui/alert';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { getReconciliations } from '@/lib/data/finance';

export const metadata = { title: 'Reconciliation' };

/**
 * What was counted against what the ledger says.
 *
 * The one rule this screen exists to enforce: a difference is never resolved
 * by changing the ledger. It stays visible until somebody with the capability
 * writes it off through an explicit journal naming the amount, and if nobody
 * does, it stays visible indefinitely. An unresolved count is surfaced at the
 * top rather than left to be found.
 */
export default async function ReconciliationPage() {
  const context = await guardPermission(ROUTES.reconciliation, 'reconciliation:view');
  const rows = await getReconciliations({ limit: 50 });

  const unresolved = rows.filter((row) => row.status === 'submitted');

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        eyebrow="Financial Ledger"
        icon={Scale}
        title="Reconciliation"
        description="Count an account against what the ledger says, and account for any difference."
        back={{ href: ROUTES.finance, label: 'Finance' }}
        primaryAction={
          contextCan(context, 'reconciliation:perform') ? (
            <ActionLink href={ROUTES.newReconciliation}>Record a count</ActionLink>
          ) : undefined
        }
      />

      {unresolved.length > 0 ? (
        <Alert tone="warning">
          {unresolved.length === 1
            ? 'One count has not been accounted for.'
            : `${String(unresolved.length)} counts have not been accounted for.`}{' '}
          The ledger is unchanged until somebody decides.
        </Alert>
      ) : null}

      <ReconciliationRegister
        rows={rows}
        canDecide={contextCan(context, 'reconciliation:approve')}
      />
    </div>
  );
}
