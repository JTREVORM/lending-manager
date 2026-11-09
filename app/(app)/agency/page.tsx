import { Network } from 'lucide-react';

import { AgencyReadError } from '@/components/agency/read-failure';
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
/**
 * A headline with no figure, because the figure was not read.
 *
 * Shaped like the `MoneyStat` beside it so the row does not jump, and
 * deliberately carrying no number at all - not a zero, not a dash that could
 * be read as one.
 */
function UnavailableStat({ label }: { readonly label: string }) {
  return (
    <div className="min-w-0">
      <p className="text-text-muted text-sm">{label}</p>
      <p className="text-danger text-lg font-semibold">Not available</p>
      <p className="text-text-muted mt-0.5 text-xs">This read failed. It is not zero.</p>
    </div>
  );
}

export default async function AgencyPage() {
  const context = await guardPermission(ROUTES.agency, 'agency:reports');

  const [commission, payables, floats, exceptions, pending] = await Promise.all([
    getAgencyCommission(),
    getAgencyPayables(),
    getAgencyFloatBalances(),
    getAgencyExceptions(),
    getAgencyTransactions({ statuses: ['awaiting_verification'], limit: 10 }),
  ]);

  // A headline figure is only shown when the read behind it happened. A
  // dashboard that answers "how much is outstanding?" with UGX 0 because a
  // query failed is worse than one that answers nothing: the officer acts on
  // the first and reloads on the second.
  const failures = [commission, payables, floats, exceptions, pending].filter(
    (read) => !read.ok,
  );

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

      {failures.map((failure) =>
        failure.ok ? null : <AgencyReadError key={failure.what} failure={failure} />,
      )}

      {/*
        These three are sums across the rows the caller may see, which is a
        presentation of per-provider figures rather than a financial total:
        each row was totalled by the database, and the only arithmetic here is
        adding independent per-provider balances for a headline.

        Each is rendered only if its own read succeeded. One failed query
        leaves its own figure absent and the other two intact, rather than
        taking down a screen that can still tell the officer something true.
      */}
      <div className="grid min-w-0 gap-3 sm:grid-cols-3">
        {commission.ok ? (
          <MoneyStat
            label="Commission outstanding"
            amount={toUgx(commission.rows.reduce((sum, r) => sum + r.outstanding, 0))}
            note={`${String(commission.rows.length)} provider${commission.rows.length === 1 ? '' : 's'}`}
          />
        ) : (
          <UnavailableStat label="Commission outstanding" />
        )}
        {payables.ok ? (
          <MoneyStat
            label="Held on providers' behalf"
            amount={toUgx(payables.rows.reduce((sum, r) => sum + r.outstanding, 0))}
            note="Owed out, not ours"
          />
        ) : (
          <UnavailableStat label="Held on providers' behalf" />
        )}
        {floats.ok ? (
          <MoneyStat
            label="Electronic float held"
            amount={toUgx(floats.rows.reduce((sum, r) => sum + r.balance, 0))}
            note={`${String(floats.rows.length)} till${floats.rows.length === 1 ? '' : 's'}`}
          />
        ) : (
          <UnavailableStat label="Electronic float held" />
        )}
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
          {!exceptions.ok ? (
            <p className="text-danger mt-2 text-sm">
              This list could not be read, so it is not a statement that nothing is
              outstanding.
            </p>
          ) : exceptions.rows.length === 0 ? (
            <p className="text-text-muted mt-2 text-sm">
              Nothing outstanding. No unverified transaction, no reconciliation awaiting a
              second officer, no empty float till.
            </p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm">
              {exceptions.rows.slice(0, 6).map((e) => (
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
        {pending.ok ? (
          <AgencyTransactionRegister
            rows={pending.rows}
            caption="Agency transactions awaiting verification"
            emptyMessage="Nothing is waiting for a second officer."
          />
        ) : (
          <AgencyReadError failure={pending} />
        )}
      </section>
    </div>
  );
}
