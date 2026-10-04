import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ClientGuarantorPanel } from '@/components/guarantors/client-guarantor-panel';
import { ClientLoanSummary } from '@/components/clients/client-loan-summary';
import { RecentPayments } from '@/components/dashboard/recent-payments';
import { ClientRemarks } from '@/components/clients/client-remarks';
import { ClientStatusBadge } from '@/components/clients/client-status-badge';
import { ClientStatusPanel } from '@/components/clients/client-status-panel';
import { DocumentPanel } from '@/components/clients/document-panel';
import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { getClient, getClientIdentity, listClientRemarks } from '@/lib/data/clients';
import { listClientGuarantors } from '@/lib/data/guarantors';
import { listRecentPayments } from '@/lib/data/dashboard';
import { getCompanyBranding } from '@/lib/data/company';
import { listClientLoans } from '@/lib/data/reports';
import { signedDocumentUrl } from '@/lib/storage/documents';
import {
  SEX_LABELS,
  formatCalendarDate,
  formatRecordedDate,
  maskNin,
} from '@/lib/domain/client';
import { PhoneValue } from '@/components/ui/data-value';

export const metadata = { title: 'Client' };

/**
 * One client's record.
 *
 * ## What a given viewer sees
 *
 * The page is assembled from what the caller may actually read, and each
 * absence is a database decision rather than a conditional here:
 *
 *   - the National Identification Number comes back null for anyone without
 *     `clients:view_nin`, because the policy on `client_identities` filters
 *     the row out. The page says it is restricted rather than pretending there
 *     is none.
 *   - remarks come back as an empty list without `clients:remarks_view`.
 *   - guarantors come back empty without `guarantors:view`.
 *
 * A missing client and an unauthorised one both render the same not-found
 * page. That is deliberate: distinguishing them would confirm that a record
 * exists to somebody who may not see it, which is the thing the policy is
 * preventing.
 */
export default async function ClientDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly clientId: string }>;
}) {
  const { clientId } = await params;
  const context = await guardPermission(`${ROUTES.clients}/${clientId}`, 'clients:view');

  const client = await getClient(clientId);

  if (client === null) notFound();

  const canSeeNin = contextCan(context, 'clients:view_nin');

  const canSeeLoans = contextCan(context, 'loans:view');
  const canSeePayments = contextCan(context, 'payments:view');

  const [identity, remarks, guarantors, loans, payments, { branding }] =
    await Promise.all([
      canSeeNin ? getClientIdentity(clientId) : Promise.resolve(null),
      listClientRemarks(clientId),
      listClientGuarantors(clientId),
      // Phase 8. The client record now answers "where does this borrower
      // stand", which previously meant opening the loan register and filtering
      // it. Fetched only for a caller who may read loans: hiding a section in
      // the markup after fetching it is the mistake that turns a presentation
      // decision into a leak.
      canSeeLoans ? listClientLoans(clientId) : Promise.resolve([]),
      canSeePayments ? listRecentPayments(8, { clientId }) : Promise.resolve([]),
      getCompanyBranding(),
    ]);

  // Signed at render time, valid for a minute. Never a permanent address.
  const [photoUrl, documentUrl] = await Promise.all([
    signedDocumentUrl('clients', client.photoPath),
    signedDocumentUrl('clients', identity?.idDocumentPath ?? null),
  ]);

  return (
    <div className="min-w-0 space-y-6">
      <div className="min-w-0">
        <Link
          href={ROUTES.clients}
          className="text-accent focus-visible:outline-accent text-sm underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          ← Clients
        </Link>

        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-text text-2xl font-semibold break-words">
              {client.fullName}
            </h1>
            <p className="text-text-muted font-mono">{client.clientNumber}</p>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <ClientStatusBadge status={client.status} />
            {contextCan(context, 'clients:update') ? (
              <Link
                href={`${ROUTES.clients}/${client.id}/edit`}
                className="border-border text-text focus-visible:outline-accent inline-flex min-h-11 items-center justify-center rounded-lg border px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                Edit
              </Link>
            ) : null}
          </div>
        </div>
      </div>

      {client.status === 'blacklisted' || client.status === 'suspended' ? (
        <Alert tone={client.status === 'blacklisted' ? 'danger' : 'warning'}>
          <span className="font-medium">
            {client.status === 'blacklisted'
              ? 'This client is blacklisted.'
              : 'This client is suspended.'}
          </span>{' '}
          {client.statusReason ?? 'No reason was recorded.'}
          {client.statusChangedAt !== null
            ? ` (${formatRecordedDate(client.statusChangedAt)})`
            : ''}
        </Alert>
      ) : null}

      {/* --- Profile ------------------------------------------------------ */}
      <section aria-labelledby="profile-heading" className="min-w-0 space-y-3">
        <h2 id="profile-heading" className="text-text text-lg font-semibold">
          Profile
        </h2>

        <Card>
          <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
            <Detail label="Phone">
              <PhoneValue value={client.phone} />
            </Detail>
            <Detail label="Alternative phone">
              {client.alternativePhone === null ? (
                '—'
              ) : (
                <PhoneValue value={client.alternativePhone} />
              )}
            </Detail>
            <Detail label="Sex">{SEX_LABELS[client.sex]}</Detail>
            <Detail label="Date of birth">
              {formatCalendarDate(client.dateOfBirth)}
            </Detail>
            <Detail label="Occupation">{client.occupation}</Detail>
            <Detail label="Business type">{client.businessType ?? '—'}</Detail>
            <Detail label="Village or area">{client.villageArea}</Detail>
            <Detail label="District">{client.district}</Detail>
            <Detail label="Registered">{formatRecordedDate(client.registeredAt)}</Detail>
            <Detail label="Portal login">
              {client.hasPortalLogin ? 'Linked' : 'Not linked'}
            </Detail>

            <Detail label="National Identification Number">
              {!canSeeNin ? (
                <span className="text-text-muted">
                  Restricted. You do not have permission to view this.
                </span>
              ) : identity?.nin == null ? (
                '—'
              ) : (
                /* Masked by default, full value behind a disclosure.
                   Somebody checking a client's record at a counter does not
                   need the whole number on screen, where a queue can read it
                   over their shoulder — but the person verifying it against
                   the card in hand needs one tap, not a separate screen. */
                <details className="min-w-0">
                  <summary className="text-text min-h-11 cursor-pointer font-mono">
                    {maskNin(identity.nin)}
                    <span className="text-accent ml-2 font-sans text-sm">Show</span>
                  </summary>
                  <span className="text-text font-mono break-all">{identity.nin}</span>
                </details>
              )}
            </Detail>

            {client.notes !== null ? (
              <div className="min-w-0 sm:col-span-2">
                <dt className="text-text-muted text-sm">Notes</dt>
                <dd className="text-text mt-1 break-words whitespace-pre-wrap">
                  {client.notes}
                </dd>
              </div>
            ) : null}
          </dl>
        </Card>
      </section>

      {/* --- Documents ---------------------------------------------------- */}
      <section aria-labelledby="documents-heading" className="min-w-0 space-y-3">
        <h2 id="documents-heading" className="text-text text-lg font-semibold">
          Photograph and documents
        </h2>

        <DocumentPanel
          clientId={client.id}
          photoUrl={photoUrl}
          documentUrl={documentUrl}
          hasDocument={identity?.idDocumentPath != null}
          canSeeDocument={canSeeNin}
          canReplace={contextCan(context, 'clients:documents')}
        />
      </section>

      {/* --- Guarantors --------------------------------------------------- */}
      {contextCan(context, 'guarantors:view') ? (
        <section aria-labelledby="guarantors-heading" className="min-w-0 space-y-3">
          <h2 id="guarantors-heading" className="text-text text-lg font-semibold">
            Guarantors
          </h2>

          <ClientGuarantorPanel
            clientId={client.id}
            links={guarantors}
            canLink={contextCan(context, 'guarantors:link')}
          />
        </section>
      ) : null}

      {/* --- Remarks ------------------------------------------------------ */}
      {contextCan(context, 'clients:remarks_view') ? (
        <section
          /* Phase 8's arrears report links here with #remarks, so a
             collections officer reading the list can reach the full timeline
             and the existing form in one click — rather than Phase 8 growing
             a second place to write a note. */
          id="remarks"
          aria-labelledby="remarks-heading"
          className="min-w-0 scroll-mt-4 space-y-3"
        >
          <h2 id="remarks-heading" className="text-text text-lg font-semibold">
            Remarks
          </h2>
          <p className="text-text-muted text-sm">
            Internal notes. The client never sees these.
          </p>

          <ClientRemarks
            clientId={client.id}
            remarks={remarks}
            canCreate={contextCan(context, 'clients:remarks_create')}
          />
        </section>
      ) : null}

      {/* --- Status ------------------------------------------------------- */}
      {contextCan(context, 'clients:status') ||
      contextCan(context, 'clients:blacklist') ||
      contextCan(context, 'clients:archive') ? (
        <section aria-labelledby="status-heading" className="min-w-0 space-y-3">
          <h2 id="status-heading" className="text-text text-lg font-semibold">
            Status
          </h2>

          <Card>
            <ClientStatusPanel
              clientId={client.id}
              currentStatus={client.status}
              currentReason={client.statusReason}
              canBlacklist={contextCan(context, 'clients:blacklist')}
              canArchive={contextCan(context, 'clients:archive')}
            />
          </Card>
        </section>
      ) : null}

      {canSeeLoans ? (
        <section aria-labelledby="client-loans-heading" className="min-w-0 space-y-3">
          <h2 id="client-loans-heading" className="text-base">
            Loans
          </h2>
          <ClientLoanSummary loans={loans} />
        </section>
      ) : null}

      {canSeePayments ? (
        <section aria-labelledby="client-payments-heading" className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="client-payments-heading" className="text-base">
              Recent payments
            </h2>
            <Link
              href={`${ROUTES.reports}/collections?period=year&clientId=${client.id}`}
              className="text-brand-700 text-sm hover:underline"
            >
              Every payment this year
            </Link>
          </div>
          <RecentPayments payments={payments} timeZone={branding.timezone} />
        </section>
      ) : null}
    </div>
  );
}

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
