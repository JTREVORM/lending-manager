import { Smartphone } from 'lucide-react';

import {
  FloatStatementForm,
  FloatStatementRegister,
} from '@/components/agency/reconciliation-forms';
import { Alert } from '@/components/ui/alert';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { getAgencyFloatBalances, getAgencyFloatStatements } from '@/lib/data/agency';

export const metadata = { title: 'Electronic float reconciliation' };

/**
 * Agreeing our float with the provider's own figure.
 *
 * The same two-officer shape as the cash count, against a different kind of
 * reading: not what is in the drawer but what the provider's system says the
 * till holds. Every till the officer may see is offered, including a
 * provisional provider's - a provider whose terms are not approved yet can
 * still have float sitting in it, and refusing to reconcile that would leave
 * a real balance unexamined.
 */
export default async function AgencyFloatReconciliationPage() {
  const context = await guardPermission(ROUTES.agencyFloatCount, 'agency:reconcile');

  const [rows, tills] = await Promise.all([
    getAgencyFloatStatements({ limit: 100 }),
    getAgencyFloatBalances(),
  ]);

  const canAdjust = contextCan(context, 'agency:variance_adjustment');

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        eyebrow="Agency Banking"
        icon={Smartphone}
        title="Electronic float reconciliation"
        description="Compare a provider's statement with the float our books hold."
        back={{ href: ROUTES.agencyFloat, label: 'Float and tills' }}
      />

      <Alert tone="info">
        Enter the provider&rsquo;s figure as it stands, even where it looks wrong. The
        difference is what the reconciliation exists to record; it is not a reason to
        adjust the reading.
      </Alert>

      <FloatStatementForm tills={tills} />

      <FloatStatementRegister
        rows={rows}
        profileId={context.profileId}
        canAdjust={canAdjust}
      />
    </div>
  );
}
