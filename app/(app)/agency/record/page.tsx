import { Network } from 'lucide-react';

import { AgencyReadError } from '@/components/agency/read-failure';

import { RecordForm } from '@/components/agency/record-form';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import {
  getAgencyProviders,
  getAgencyServiceTypes,
  getOperatingBranches,
  getPostableFloatTills,
} from '@/lib/data/agency';

export const metadata = { title: 'Record transaction' };

export default async function RecordAgencyTransactionPage() {
  const context = await guardPermission(ROUTES.agencyRecord, 'agency:write');

  const [providers, allServices, tills, branches] = await Promise.all([
    getAgencyProviders(),
    getAgencyServiceTypes(),
    getPostableFloatTills(),
    // Where this officer may record. `create_agency_transaction()` no longer
    // works the branch out for an officer who has none of their own — there
    // was a fallback and it chose the alphabetically first branch — so the
    // form has to ask, and this is what it asks from.
    getOperatingBranches(context.profileId),
  ]);

  const header = (
    <PageHeader
      eyebrow="Agency Banking"
      icon={Network}
      title="Record transaction"
      description="What the customer asked for and what the provider's system said."
      back={{ href: ROUTES.agency, label: 'Agency Services' }}
    />
  );

  // A form built from a failed read would offer no service to choose and
  // say "every provider is still provisional" - a statement about the
  // configuration, made from a query that never ran. The officer needs to
  // know it is the screen that is broken, not the counter.
  const failure = [providers, allServices, tills, branches].find((read) => !read.ok);
  if (failure !== undefined && !failure.ok) {
    return (
      <div className="min-w-0 space-y-4">
        {header}
        <AgencyReadError failure={failure} />
      </div>
    );
  }
  if (!providers.ok || !allServices.ok || !tills.ok || !branches.ok) return null;

  // Only services whose provider the posting engine would actually accept.
  // The readiness gate refuses a provisional or inactive provider in the
  // database; offering one here would be offering a refusal.
  const live = new Set(
    providers.rows.filter((p) => p.isActive && !p.isProvisional).map((p) => p.id),
  );
  const services = allServices.rows.filter((s) => s.isActive && live.has(s.providerId));

  // Confirmed terms only. A provider with no rate and no fixed amount, or one
  // configured with both — which the database refuses rather than resolves —
  // contributes nothing, so the form shows no figure instead of a guess.
  const terms: Record<string, { rateBps: number | null; fixed: number | null }> = {};
  for (const p of providers.rows) {
    if (!live.has(p.id)) continue;
    const hasRate = p.commissionRateBps !== null;
    const hasFixed = p.commissionFixed !== null;
    if (hasRate === hasFixed) continue;
    terms[p.id] = { rateBps: p.commissionRateBps, fixed: p.commissionFixed };
  }

  return (
    <div className="min-w-0 space-y-4">
      {header}
      <RecordForm
        services={services}
        tills={tills.rows}
        terms={terms}
        branches={branches.row.choices}
        ownBranch={branches.row.own}
      />
    </div>
  );
}
