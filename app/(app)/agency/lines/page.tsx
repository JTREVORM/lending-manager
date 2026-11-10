import { SmartphoneNfc } from 'lucide-react';

import {
  AgentLineRegistrationForm,
  AgentLineSuspension,
  AgentLineUpdateForm,
  CommissionSourceForm,
  ServiceLimitForm,
} from '@/components/agency/agent-line-forms';
import { AgencyReadError } from '@/components/agency/read-failure';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import {
  getAgencyAgentLineObligations,
  getAgencyLineCommission,
  getAgencyProviders,
  getAgencyServiceTypes,
} from '@/lib/data/agency';
import { getBranchOptions } from '@/lib/data/products';

export const metadata = { title: 'Agent lines' };

/**
 * Administering the Mobile Money agent lines.
 *
 * ## Why this is a card per line rather than a table
 *
 * Every control here is destructive or commercial — suspending a line,
 * closing it for good, setting a ceiling — and each needs a typed reason
 * beside it. A table of buttons invites the wrong row being clicked; a card
 * states which line it is about above the controls that act on it.
 *
 * ## Why closing is offered only when the database would allow it
 *
 * `agency_agent_line_obligations()` is the same function the close refuses
 * on, so the list shown is what would actually block it rather than a
 * second opinion computed here. When that read fails the button is withheld
 * and the screen says the check could not be made — not that the line is
 * clear, which is the failure mode this project has hunted since Phase 19.
 */
export default async function AgencyAgentLinesPage() {
  await guardPermission(ROUTES.agencyLines, 'agency:providers');

  const [lines, providers, services, branches] = await Promise.all([
    getAgencyLineCommission(),
    getAgencyProviders(),
    getAgencyServiceTypes(),
    getBranchOptions(),
  ]);

  // The obligations are read per line, through the same function the close
  // refuses on. Only open lines need it: a closed one has nothing left to
  // check.
  const obligations = new Map<string, readonly string[] | null>();
  if (lines.ok) {
    const open = lines.rows.filter((l) => l.lineStatus !== 'closed');
    const results = await Promise.all(
      open.map(async (l) => {
        const read = await getAgencyAgentLineObligations(l.floatAccountId);
        return [l.floatAccountId, read.ok ? read.row : null] as const;
      }),
    );
    for (const [id, value] of results) obligations.set(id, value);
  }

  const header = (
    <PageHeader
      eyebrow="Mobile Money"
      icon={SmartphoneNfc}
      title="Agent lines"
      description="Opening a line, correcting its identifiers, suspending it, closing it, and the commercial controls behind it."
      back={{ href: ROUTES.agencyMoney, label: 'Mobile Money' }}
    />
  );

  return (
    <div className="min-w-0 space-y-4">
      {header}

      <Alert tone="info">
        Nothing on this screen activates a provider or agrees a rate. A provider goes live
        only once its commission basis and its transaction ceilings have been approved and
        recorded, and that is a separate decision of the Owner&rsquo;s.
      </Alert>

      {providers.ok ? (
        <AgentLineRegistrationForm providers={providers.rows} branches={branches} />
      ) : (
        <AgencyReadError failure={providers} />
      )}

      {!lines.ok ? (
        <AgencyReadError failure={lines} />
      ) : lines.rows.length === 0 ? (
        <Alert tone="info">No agent line exists at a branch you can see.</Alert>
      ) : (
        <div className="grid min-w-0 gap-3 lg:grid-cols-2">
          {lines.rows.map((l) => (
            // `role="group"` with the line's own name: every control in
            // this card acts on one agent line, and a reason field or a
            // close button found by its label alone would otherwise be
            // ambiguous between the lines on the screen — to a screen
            // reader as much as to a test.
            <Card
              key={l.floatAccountId}
              role="group"
              aria-label={`Agent line ${l.label ?? l.tillName}`}
            >
              <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold">
                  {l.label ?? l.tillName}
                  <span className="text-muted ml-2 text-xs font-normal">
                    {l.providerName} · {l.branchCode}
                  </span>
                </h2>
                <Badge
                  tone={
                    l.lineStatus === 'active'
                      ? 'success'
                      : l.lineStatus === 'suspended'
                        ? 'warning'
                        : 'neutral'
                  }
                >
                  {l.lineStatus}
                </Badge>
              </div>

              <dl className="text-muted mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <dt>Ledger account</dt>
                <dd className="font-mono">{l.ledgerAccountCode}</dd>
                <dt>Float held</dt>
                <dd className="tabular-nums">
                  <Money amount={l.floatBalance} />
                </dd>
                <dt>Commission owed to us</dt>
                <dd className="tabular-nums">
                  <Money amount={l.commissionOutstanding} />
                </dd>
                <dt>Owed back to the provider</dt>
                <dd className="tabular-nums">
                  <Money amount={l.recoveryOwed} />
                </dd>
              </dl>

              {l.lineStatus === 'closed' ? (
                <p className="text-muted mt-3 text-xs">
                  Closed. Its history and its ledger account stay; it can never transact
                  again.
                </p>
              ) : (
                <div className="mt-3 min-w-0 space-y-4">
                  <AgentLineUpdateForm line={l} />
                  <AgentLineSuspension
                    line={l}
                    obligations={obligations.get(l.floatAccountId) ?? null}
                  />
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {services.ok ? (
        <ServiceLimitForm services={services.rows} />
      ) : (
        <AgencyReadError failure={services} />
      )}

      {providers.ok ? <CommissionSourceForm providers={providers.rows} /> : null}
    </div>
  );
}
