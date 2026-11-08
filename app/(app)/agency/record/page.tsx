import { Network } from 'lucide-react';

import { RecordForm } from '@/components/agency/record-form';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import {
  getAgencyProviders,
  getAgencyServiceTypes,
  getPostableFloatTills,
} from '@/lib/data/agency';

export const metadata = { title: 'Record transaction' };

export default async function RecordAgencyTransactionPage() {
  await guardPermission(ROUTES.agencyRecord, 'agency:write');

  const [providers, allServices, tills] = await Promise.all([
    getAgencyProviders(),
    getAgencyServiceTypes(),
    getPostableFloatTills(),
  ]);

  // Only services whose provider the posting engine would actually accept.
  // The readiness gate refuses a provisional or inactive provider in the
  // database; offering one here would be offering a refusal.
  const live = new Set(
    providers.filter((p) => p.isActive && !p.isProvisional).map((p) => p.id),
  );
  const services = allServices.filter((s) => s.isActive && live.has(s.providerId));

  // Confirmed terms only. A provider with no rate and no fixed amount, or one
  // configured with both — which the database refuses rather than resolves —
  // contributes nothing, so the form shows no figure instead of a guess.
  const terms: Record<string, { rateBps: number | null; fixed: number | null }> = {};
  for (const p of providers) {
    if (!live.has(p.id)) continue;
    const hasRate = p.commissionRateBps !== null;
    const hasFixed = p.commissionFixed !== null;
    if (hasRate === hasFixed) continue;
    terms[p.id] = { rateBps: p.commissionRateBps, fixed: p.commissionFixed };
  }

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        eyebrow="Agency Banking"
        icon={Network}
        title="Record transaction"
        description="What the customer asked for and what the provider's system said."
        back={{ href: ROUTES.agency, label: 'Agency Services' }}
      />
      <RecordForm services={services} tills={tills} terms={terms} />
    </div>
  );
}
