import { Network } from 'lucide-react';

import { Card } from '@/components/ui/card';
import { MoneyStat } from '@/components/ui/money';
import { ActionLink, PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import {
  getAgencyCommission,
  getAgencyExceptions,
  getAgencyFloatBalances,
  getAgencyPayables,
  getAgencyTransactions,
} from '@/lib/data/agency';
import { AgencyTransactionRegister } from '@/components/agency/transaction-register';
import { toUgx } from '@/lib/domain/money';
import Link from 'next/link';

export const metadata = { title: 'Agency Services' };

/**
 * The agency counter's own dashboard.
 *
 * Every figure comes from one of the Phase 4C views, which total them in the
 * database per provider and per branch. Nothing on this page adds anything up:
 * GL 1310 and the 2200-series accounts are shared between providers, so a
 * total computed here over whatever rows came back would mix them.
 */
export default async function AgencyPage() {
  const context = await guardPermission(ROUTES.agency, 'agency:reports');

  const [commission, payables, floats, exceptions, pending] = await Promise.all([
    getAgencyCommission(),
    getAgencyPayables(),
    getAgencyFloatBalances(),
    getAgencyExceptions(),
    getAgencyTransactions({ statuses: ['awaiting_verification'], limit: 10 }),
  ]);

  const outstandingCommission = commission.reduce((sum, r) => sum + r.outstanding, 0);
  const outstandingPayable = payables.reduce((sum, r) => sum + r.outstanding, 0);
  const floatHeld = floats.reduce((sum, r) => sum + r.balance, 0);

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        eyebrow="Agency Banking"
        icon={Network}
        title="Agency Services"
        description="Mobile money, bank agency, utilities and school fees collected at the counter."
        primaryAction={
          contextCan(context, 'agency:write') ? (
            <ActionLink href={ROUTES.agencyRecord}>Record transaction</ActionLink>
          ) : undefined
        }
      />

      {/*
        These three are sums across the rows the caller may see, which is a
        presentation of per-provider figures rather than a financial total:
        each row was totalled by the database, and the only arithmetic here is
        adding independent per-provider balances for a headline.
      */}
      <div className="grid min-w-0 gap-3 sm:grid-cols-3">
        <MoneyStat
          label="Commission outstanding"
          amount={toUgx(outstandingCommission)}
          note={`${String(commission.length)} provider${commission.length === 1 ? '' : 's'}`}
        />
        <MoneyStat
          label="Held on providers' behalf"
          amount={toUgx(outstandingPayable)}
          note="Owed out, not ours"
        />
        <MoneyStat
          label="Electronic float held"
          amount={toUgx(floatHeld)}
          note={`${String(floats.length)} till${floats.length === 1 ? '' : 's'}`}
        />
      </div>

      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <Card>
          <h2 className="text-sm font-semibold">Where to go</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {[
              { href: ROUTES.agencyPending, label: 'Pending verification' },
              { href: ROUTES.agencyHistory, label: 'Transaction history' },
              { href: ROUTES.agencyFloat, label: 'Float and till balances' },
              { href: ROUTES.agencyCommission, label: 'Commission and settlement' },
              { href: ROUTES.agencyPayables, label: 'Provider remittances' },
              { href: ROUTES.agencyCashCount, label: 'Cash reconciliation' },
              { href: ROUTES.agencyFloatCount, label: 'Float reconciliation' },
              { href: ROUTES.agencyReports, label: 'Reports' },
              { href: ROUTES.agencyExceptions, label: 'End-of-day exceptions' },
              // Last, and only for the officer who can open it: the route
              // needs `agency:providers`, and a link that leads to a refusal
              // is worse than no link. A counter officer never needs it; an
              // Owner reads it once.
              ...(contextCan(context, 'agency:providers')
                ? [{ href: ROUTES.agencyProviders, label: 'Providers and services' }]
                : []),
            ].map((item) => (
              <li key={item.href}>
                <Link href={item.href} className="text-brand hover:underline">
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <h2 className="text-sm font-semibold">Needs attention today</h2>
          {exceptions.length === 0 ? (
            <p className="text-text-muted mt-2 text-sm">
              Nothing outstanding. No unverified transaction, no reconciliation awaiting a
              second officer, no empty float till.
            </p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm">
              {exceptions.slice(0, 6).map((e) => (
                <li key={`${e.kind}-${e.subjectId}`} className="min-w-0">
                  <span className="font-medium">{e.detail}</span>
                  {e.providerName === null ? null : (
                    <span className="text-text-muted"> — {e.providerName}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <Link
            href={ROUTES.agencyExceptions}
            className="text-brand mt-2 inline-block text-xs hover:underline"
          >
            All exceptions
          </Link>
        </Card>
      </div>

      <section className="min-w-0 space-y-2">
        <h2 className="text-sm font-semibold">Awaiting verification</h2>
        <AgencyTransactionRegister
          rows={pending}
          caption="Agency transactions awaiting verification"
          emptyMessage="Nothing is waiting for a second officer."
        />
      </section>
    </div>
  );
}
