import { Receipt } from 'lucide-react';
import { notFound } from 'next/navigation';

import { AgencyDirectionBadge, AgencyStatusBadge } from '@/components/agency/badges';
import { CommissionExceptionForm } from '@/components/agency/commission-exception-form';
import { LifecycleControls } from '@/components/agency/lifecycle-controls';
import { Card } from '@/components/ui/card';
import { DateValue } from '@/components/ui/data-value';
import { Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { getAgencyTransaction } from '@/lib/data/agency';
import { businessToday } from '@/lib/domain/datetime';

export const metadata = { title: 'Transaction' };

/**
 * One agency transaction, in full, with whatever can be done to it next.
 *
 * Shows every field the brief requires of a financial action: provider and
 * service, branch, amount in shillings, commission and customer fee, the
 * external reference, the status, and who recorded and verified it. The
 * controls beneath either call a real server action or say why they cannot.
 */
export default async function AgencyTransactionPage({
  params,
}: {
  readonly params: Promise<{ readonly transactionId: string }>;
}) {
  const { transactionId } = await params;
  const context = await guardPermission(ROUTES.agencyHistory, 'agency:reports');
  const row = await getAgencyTransaction(transactionId);

  // Absent, or at a branch this officer may not see — the view returns
  // nothing in both cases, and they are deliberately indistinguishable.
  if (row === null) notFound();

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        eyebrow="Agency Banking"
        icon={Receipt}
        title={`${row.providerName} — ${row.typeName}`}
        description={`Recorded at ${row.branchCode}.`}
        back={{ href: ROUTES.agencyHistory, label: 'Transaction history' }}
      />

      <Card>
        <dl className="grid min-w-0 gap-3 sm:grid-cols-2">
          <Detail label="Status">
            <AgencyStatusBadge status={row.status} />{' '}
            <AgencyDirectionBadge direction={row.direction} />
          </Detail>
          <Detail label="Date">
            <DateValue value={row.transactionDate} />
          </Detail>
          <Detail label="Provider">
            {row.providerName} ({row.providerCode})
          </Detail>
          <Detail label="Service">
            {row.typeName} ({row.typeCode})
          </Detail>
          <Detail label="Branch">{row.branchCode}</Detail>
          <Detail label="Customer">{row.customerIdentifier ?? '—'}</Detail>
          <Detail label="Amount">
            <Money amount={row.principalAmount} />
          </Detail>
          <Detail label="Customer fee">
            <Money amount={row.customerFee} />
          </Detail>
          <Detail label="Commission recognised">
            {row.commissionAmount === null ? (
              '—'
            ) : (
              <Money amount={row.commissionAmount} />
            )}
          </Detail>
          <Detail label="Commission the terms produce">
            {row.commissionComputed === null ? (
              '—'
            ) : (
              <Money amount={row.commissionComputed} />
            )}
          </Detail>
          <Detail label="Provider reference">
            <span className="font-mono text-xs">{row.providerReference ?? '—'}</span>
          </Detail>
          <Detail label="Journal entry">
            <span className="font-mono text-xs">
              {row.journalEntryId ?? 'Not posted'}
            </span>
          </Detail>
          <Detail label="Recorded by">{row.submittedBy ?? '—'}</Detail>
          <Detail label="Verified by">{row.verifiedBy ?? '—'}</Detail>
          {row.reversalEntryId === null ? null : (
            <Detail label="Contra entry">
              <span className="font-mono text-xs">{row.reversalEntryId}</span>
            </Detail>
          )}
          {row.commissionExceptionReason === null ? null : (
            <Detail label="Commission difference authorised">
              {row.commissionExceptionReason}
            </Detail>
          )}
          {/*
            Shown because verification quotes it back. A manager who presses
            Verify is approving these figures at this version, and the
            database refuses the posting if a newer one exists by then.
          */}
          <Detail label="Figures version">{row.revision ?? '—'}</Detail>
        </dl>
      </Card>

      {contextCan(context, 'agency:commission_exception') &&
      (row.status === 'draft' || row.status === 'awaiting_verification') ? (
        <Card>
          <h2 className="text-sm font-semibold">Authorise a commission difference</h2>
          <p className="text-text-muted mt-1 text-xs">
            The counter records no commission: the engine computes it from the
            provider&rsquo;s configured terms. A different figure is the Owner&rsquo;s
            decision, and needs a reason and something checkable.
          </p>
          <div className="mt-2 min-w-0">
            <CommissionExceptionForm
              transactionId={row.id}
              computed={row.commissionComputed}
              supplied={row.commissionSupplied}
              alreadyAuthorised={row.commissionExceptionReason !== null}
            />
          </div>
        </Card>
      ) : null}

      <Card>
        <h2 className="text-sm font-semibold">What happens next</h2>
        <div className="mt-2 min-w-0">
          <LifecycleControls
            transactionId={row.id}
            status={row.status}
            isOwnEntry={row.submittedBy === context.profileId}
            canWrite={contextCan(context, 'agency:write')}
            canVerify={contextCan(context, 'agency:verify')}
            canReverse={contextCan(context, 'agency:reverse')}
            canReverseCrossDay={contextCan(context, 'agency:reverse_cross_day')}
            isPriorDay={row.transactionDate < businessToday()}
            reviewedRevision={row.revision}
          />
        </div>
      </Card>
    </div>
  );
}

/** One labelled value in a detail list. The convention used across the app. */
function Detail({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-text-muted text-sm">{label}</dt>
      <dd className="text-text mt-0.5 break-words">{children}</dd>
    </div>
  );
}
