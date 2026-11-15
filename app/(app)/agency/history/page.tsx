import { Receipt } from 'lucide-react';

import { FilterChips } from '@/components/agency/filter-chips';
import { AgencyReadError } from '@/components/agency/read-failure';
import { AgencyTransactionRegister } from '@/components/agency/transaction-register';
import { Card, CardHeader } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { getAgencyProviders, getAgencyTransactions } from '@/lib/data/agency';
import { AGENCY_STATUSES, isAgencyStatus, type AgencyStatus } from '@/lib/domain/agency';

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * The provider and the state a request asks for.
 *
 * A malformed value falls back to the whole register rather than erroring: a
 * filter is a convenience, not a control. What a reader may see is decided by
 * the capability on the route and by the view's own row-level policy, and
 * neither is affected by anything here — a hand-typed provider code gets that
 * code in a heading and no rows.
 */
function readFilter(params: SearchParams): {
  readonly providerCode: string | null;
  readonly status: AgencyStatus | null;
} {
  const provider = params.provider;
  const status = params.status;

  return {
    providerCode:
      typeof provider === 'string' && /^[A-Z0-9_]{2,32}$/.test(provider)
        ? provider
        : null,
    status: isAgencyStatus(status) ? status : null,
  };
}

export async function generateMetadata({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}): Promise<{ readonly title: string }> {
  const { providerCode } = readFilter(await searchParams);
  return {
    title:
      providerCode === null
        ? 'Transaction history'
        : `${providerCode} transaction history`,
  };
}

/**
 * Every agency transaction the caller may see, optionally narrowed.
 *
 * Which rows those are is decided by the view's own row-level policy: the
 * branch the officer belongs to, or every branch for a Head Office profile. A
 * borrower holds no agency capability and is refused the route outright.
 *
 * ## Why the provider filter is a parameter rather than a route
 *
 * The rail carries a "Transactions" row under each configured Mobile Money
 * network, and each points here with the network's code. A route per provider
 * would be a route that has to be created when a provider is registered,
 * which is the restructuring the client's requirements rule out. The filter
 * chips below are links for the same reason the reporting hub's are: the back
 * button works, a filtered register can be bookmarked, and the page needs no
 * JavaScript.
 */
export default async function AgencyHistoryPage({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}) {
  await guardPermission(ROUTES.agencyHistory, 'agency:reports');
  const filter = readFilter(await searchParams);

  const [rows, providers] = await Promise.all([
    getAgencyTransactions({
      limit: 200,
      ...(filter.providerCode === null ? {} : { providerCode: filter.providerCode }),
      ...(filter.status === null ? {} : { statuses: [filter.status] }),
    }),
    getAgencyProviders(),
  ]);

  const provider =
    providers.ok && filter.providerCode !== null
      ? (providers.rows.find((p) => p.code === filter.providerCode) ?? null)
      : null;

  const href = (next: {
    readonly provider?: string | null;
    readonly status?: AgencyStatus | null;
  }): string => {
    const query = new URLSearchParams();
    const code = next.provider === undefined ? filter.providerCode : next.provider;
    const state = next.status === undefined ? filter.status : next.status;
    if (code !== null) query.set('provider', code);
    if (state !== null) query.set('status', state);
    const text = query.toString();
    return text === '' ? ROUTES.agencyHistory : `${ROUTES.agencyHistory}?${text}`;
  };

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        eyebrow="Agency"
        icon={Receipt}
        title={
          provider === null ? 'Transaction history' : `${provider.name} transactions`
        }
        description="Recorded, verified, reversed and cancelled — the whole counter."
        back={{ href: ROUTES.agency, label: 'Agency Services' }}
      />

      <Card>
        <CardHeader title="Narrow the register" />
        <div className="min-w-0 space-y-3">
          {providers.ok && providers.rows.length > 0 ? (
            <FilterChips
              label="Provider"
              options={[
                {
                  href: href({ provider: null }),
                  label: 'Every provider',
                  active: filter.providerCode === null,
                },
                ...providers.rows.map((p) => ({
                  href: href({ provider: p.code }),
                  label: p.name,
                  active: filter.providerCode === p.code,
                })),
              ]}
            />
          ) : null}

          <FilterChips
            label="State"
            options={[
              {
                href: href({ status: null }),
                label: 'Every state',
                active: filter.status === null,
              },
              ...AGENCY_STATUSES.map((state) => ({
                href: href({ status: state }),
                label: state.replace(/_/g, ' '),
                active: filter.status === state,
              })),
            ]}
          />
        </div>
      </Card>

      {rows.ok ? (
        <AgencyTransactionRegister
          rows={rows.rows}
          caption="Agency transaction history"
          emptyMessage={
            filter.providerCode === null && filter.status === null
              ? 'No agency transaction has been recorded yet.'
              : 'No agency transaction matches this filter.'
          }
        />
      ) : (
        <AgencyReadError failure={rows} />
      )}
    </div>
  );
}
