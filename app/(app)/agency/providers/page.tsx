import { Settings2 } from 'lucide-react';

import { AgencyReadError } from '@/components/agency/read-failure';

import { ProviderReadinessBadge } from '@/components/agency/badges';
import { FloatModelCorrectionForm } from '@/components/agency/float-model-form';
import { ProviderProvisioning } from '@/components/agency/provider-provisioning';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { DataTable, TableCell, TableHead, TableRow } from '@/components/ui/data-table';
import { Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyTableRow } from '@/components/ui/states';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import {
  getAgencyAgentAccountRegister,
  getAgencyProviderReadiness,
  getAgencyProviders,
  getAgencyServiceTypes,
  getLiabilityAccountOptions,
  getOperatingBranches,
} from '@/lib/data/agency';
import { providerBlockedReason } from '@/lib/domain/agency';

export const metadata = { title: 'Providers and services' };

/**
 * The commercial terms every posting is computed from, and how a partner
 * comes to have them.
 *
 * ## What this screen used to say, and why it no longer says it
 *
 * Until the operational tasks it said:
 *
 *   > Registering a provider, approving its commercial terms or making it
 *   > live is not a screen in this release: the approval workflow for
 *   > commercial terms has not been decided.
 *
 * That was accurate and it was the gap. `STANBIC` was the only bank POLYTOS
 * could ever have; adding Equity or Centenary meant a hand-written migration
 * with the commission rate taken on trust from whatever the ticket said. That
 * is not an approval control, it is the absence of one.
 *
 * The workflow now exists, and the panels below are it, in the order the
 * business works in:
 *
 *   1. One Owner registers the partner. The row is written provisional and
 *      inactive; nothing can be posted against it.
 *   2. A *second* Owner approves its commission against the signed agreement.
 *   3. The same authority approves the float facility the partner has agreed.
 *   4. Agent accounts are opened — one per location, with the partner's own
 *      account number and agent identifier.
 *   5. Each service gets a ceiling and, where wanted, a threshold above which
 *      only the Owner may verify.
 *   6. Somebody who did not register it authorizes it to go live, naming the
 *      instrument they were authorized under.
 *
 * Every one of those is refused by the database as well as by this screen,
 * and the separation-of-duties rules are refusals about *people* — which no
 * rendered page can know in advance. So the panels are always shown and the
 * refusal, when it comes, says to ask a colleague.
 *
 * ## `requires_approval_above` is enforced now
 *
 * It was shown struck through here, with an alert explaining that the posting
 * engine did not read it. It does: above the threshold,
 * `verify_agency_transaction()` refuses a verifier without
 * `agency:verify_high_value`, and a trigger refuses the transition into
 * `posted` whatever route stamped the verifier. The column is a working
 * control and is presented as one.
 *
 * ## The float-model correction, still here and still narrow
 *
 * The Owner's decision 1 added `set_agency_provider_float_model()`, and the
 * panel at the foot of this screen calls it. It writes one fact: where a
 * *provisional* provider's money sits. It cannot touch commission terms,
 * cannot make a provider live, refuses a confirmed provider outright, and now
 * also refuses a provider with open agent accounts — because whether an agent
 * account holds float is decided by that very setting.
 */

/** Basis points as a percentage, exactly: 150 becomes 1.50%. */
function ratePercent(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const fraction = Math.abs(bps % 100);
  return `${String(whole)}.${String(fraction).padStart(2, '0')}%`;
}

export default async function AgencyProvidersPage() {
  const context = await guardPermission(ROUTES.agencyProviders, 'agency:providers');

  const [providers, types, liabilities, readiness, agentAccounts, branches] =
    await Promise.all([
      getAgencyProviders(),
      getAgencyServiceTypes(),
      getLiabilityAccountOptions(),
      getAgencyProviderReadiness(),
      getAgencyAgentAccountRegister(),
      getOperatingBranches(context.profileId),
    ]);

  const header = (
    <PageHeader
      eyebrow="Agency Banking"
      icon={Settings2}
      title="Providers and services"
      description="The terms every commission figure is computed from."
      back={{ href: ROUTES.agency, label: 'Agency Services' }}
    />
  );

  // "No provider is registered" is a claim about the configuration every
  // commission figure is computed from. It is not something to say because
  // a query failed.
  const failure = [providers, types].find((read) => !read.ok);
  if (failure !== undefined && !failure.ok) {
    return (
      <div className="min-w-0 space-y-4">
        {header}
        <AgencyReadError failure={failure} />
      </div>
    );
  }
  if (!providers.ok || !types.ok) return null;

  const thresholded = types.rows.filter((t) => t.requiresApprovalAbove !== null);

  return (
    <div className="min-w-0 space-y-4">
      {header}

      <Alert tone="info">
        Registering a partner, approving its commission against the signed agreement,
        approving its float facility, opening its agent accounts and authorizing it to go
        live are the panels below. Each needs a capability, and three of them refuse the
        person who registered the provider: bringing a partner live takes two
        Owner/Administrator accounts, which is the control rather than an inconvenience.
      </Alert>

      <Card>
        <h2 className="text-sm font-semibold">Providers</h2>
        <div className="mt-2 min-w-0">
          <DataTable caption="Registered agency providers and their commission terms">
            <thead>
              <tr>
                <TableHead width="ref">Code</TableHead>
                <TableHead width="name">Provider</TableHead>
                <TableHead width="ref">Category</TableHead>
                <TableHead width="name">Money model</TableHead>
                <TableHead width="name">Commission</TableHead>
                <TableHead width="prose">Readiness</TableHead>
              </tr>
            </thead>
            <tbody>
              {providers.rows.length === 0 ? (
                <EmptyTableRow colSpan={6}>No provider is registered.</EmptyTableRow>
              ) : (
                providers.rows.map((p) => {
                  const blocked = providerBlockedReason(p);
                  return (
                    <TableRow key={p.id}>
                      <TableCell header>
                        <span className="font-mono text-xs">{p.code}</span>
                      </TableCell>
                      <TableCell>{p.name}</TableCell>
                      <TableCell>{p.category}</TableCell>
                      <TableCell>
                        {p.floatModel === 'provider_float'
                          ? 'Electronic float'
                          : 'Cash, payable to the provider'}
                        <span className="text-text-muted mt-0.5 block text-[10px]">
                          {p.commissionModel === 'deferred'
                            ? 'Commission receivable until settled'
                            : 'Commission received at once'}
                        </span>
                      </TableCell>
                      <TableCell>
                        {/*
                          Exactly one of the two is set - the table refuses a
                          provider carrying both - so whichever it is, is the
                          headline rather than a footnote under an empty line.
                        */}
                        {p.commissionRateBps !== null ? (
                          <span className="tabular-nums">
                            {ratePercent(p.commissionRateBps)} of the amount
                          </span>
                        ) : p.commissionFixed !== null ? (
                          <span className="tabular-nums">
                            <Money amount={p.commissionFixed} /> a transaction
                          </span>
                        ) : (
                          <span className="text-text-muted">No terms recorded</span>
                        )}
                      </TableCell>
                      <TableCell wrap="wrap">
                        <ProviderReadinessBadge
                          isActive={p.isActive}
                          isProvisional={p.isProvisional}
                        />
                        {/*
                          The badge says the state; this says what it means for
                          the counter, which is the question an officer is
                          actually asking when they open this screen.
                        */}
                        <span className="text-text-muted mt-1 block text-[10px]">
                          {blocked ?? 'Can be posted against.'}
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </tbody>
          </DataTable>
        </div>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold">Transaction types</h2>
        <p className="text-text-muted mt-1 text-xs">
          What each provider offers, and the single-transaction ceiling the database
          enforces on it. A type with no ceiling cannot be posted past draft at all.
        </p>
        <div className="mt-2 min-w-0">
          <DataTable caption="Agency transaction types and their limits">
            <thead>
              <tr>
                <TableHead width="ref">Code</TableHead>
                <TableHead width="name">Provider</TableHead>
                <TableHead width="name">Service</TableHead>
                <TableHead width="ref">Direction</TableHead>
                <TableHead align="numeric" width="money">
                  Maximum one transaction
                </TableHead>
                {/*
                  The heading no longer carries a disclaimer, because there is
                  nothing left to disclaim. It read "Approval threshold (not
                  enforced)" while the posting engine ignored the column; the
                  threshold now gates verification, so the honest heading is
                  the plain one and the figures below are no longer struck
                  through.
                */}
                <TableHead align="numeric" width="money">
                  Owner must verify above
                </TableHead>
                <TableHead width="status">Active</TableHead>
              </tr>
            </thead>
            <tbody>
              {types.rows.length === 0 ? (
                <EmptyTableRow colSpan={7}>No service type is configured.</EmptyTableRow>
              ) : (
                types.rows.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell header>
                      <span className="font-mono text-xs">{t.code}</span>
                    </TableCell>
                    <TableCell>{t.providerName}</TableCell>
                    <TableCell>{t.name}</TableCell>
                    <TableCell>{t.direction}</TableCell>
                    <TableCell align="numeric">
                      {t.maxSingleTransaction === null ? (
                        <span className="text-text-muted">None set</span>
                      ) : (
                        <Money amount={t.maxSingleTransaction} />
                      )}
                    </TableCell>
                    <TableCell align="numeric">
                      {t.requiresApprovalAbove === null ? (
                        <span className="text-text-muted">Any amount</span>
                      ) : (
                        <Money amount={t.requiresApprovalAbove} />
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge tone={t.isActive ? 'success' : 'neutral'} shape="pill">
                        {t.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </tbody>
          </DataTable>
        </div>
      </Card>

      <Alert tone="info">
        <strong>Two limits, and they do different things.</strong> The maximum is what may
        be transacted at all, and the database refuses past it. The threshold is what may
        be transacted without the Owner looking at it: above it, a Manager&rsquo;s
        verification is refused and somebody holding the high-value capability has to post
        it — enforced both in the verification path and by a trigger on the transition
        into posted, so no route can skip it.{' '}
        {thresholded.length === 0
          ? 'No service carries a threshold yet, so every amount up to each maximum may be verified by a Manager.'
          : thresholded.length === 1
            ? 'One service carries one.'
            : `${String(thresholded.length)} services carry one.`}
      </Alert>

      {/*
        The workflow the old header said did not exist.

        A failed readiness read is not a reason to withhold it: the panels are
        forms, the database is the gate, and a form with an empty provider
        list says so. What a failed read must not do is render as "no provider
        needs anything", which is why the readiness table says what it could
        not read.
      */}
      <ProviderProvisioning
        readiness={readiness.ok ? readiness.rows : []}
        agentAccounts={agentAccounts.ok ? agentAccounts.rows : []}
        serviceTypes={types.rows}
        branches={branches.ok ? branches.row.choices : []}
        canConfigure={contextCan(context, 'agency:providers')}
        canApprove={contextCan(context, 'agency:provider_approval')}
      />

      {readiness.ok ? null : <AgencyReadError failure={readiness} />}

      <Card>
        <CardHeader
          title="Correct a provisional provider's money model"
          description="Whether the provider advances electronic float, or the company holds the customer's cash and owes it onward."
        />

        <Alert tone="warning" className="mb-3">
          <p>
            <strong>This is a configuration correction, not a financial one.</strong> No
            posted entry is altered, and the change is refused for any provider that holds
            float, owes anything on its payable, or has a posted or in-flight transaction.
            What it governs is what gets posted next.
          </p>
          <p className="mt-2">
            The commercial detail each bank still owes us is separate and is not settled
            by this control: the float facility&rsquo;s limit and terms, the commission
            rate per transaction type, when commission is paid, and which bank account the
            float is drawn against. A provider stays provisional until those are confirmed
            and approved, and a provisional provider cannot be posted against.
          </p>
        </Alert>

        {/*
          A failed liability read is not a reason to withhold the panel. Moving a
          provider *to* `cash_payable` needs a liability account named and would
          have nothing to offer; moving one to `provider_float` — the direction
          the Owner's decision 1 is actually about — needs no account at all.
        */}
        <FloatModelCorrectionForm
          providers={providers.rows}
          liabilities={liabilities.ok ? liabilities.rows : []}
        />
      </Card>
    </div>
  );
}
