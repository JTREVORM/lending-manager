import { Construction } from 'lucide-react';

import { Card } from '@/components/ui/card';
import { ClientStatusBadge } from '@/components/clients/client-status-badge';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { getOwnClientRecord } from '@/lib/data/clients';
import { signedDocumentUrl } from '@/lib/storage/documents';
import { formatRecordedDate } from '@/lib/domain/client';
import { formatUgandanPhoneLocal } from '@/lib/domain/phone';

export const metadata = { title: 'My account' };

/**
 * The client portal landing page.
 *
 * As of Phase 3 a borrower whose login is linked to a client record sees that
 * record's basic details. Resolved through the identity clause in the policy on
 * `public.clients` — `profile_id = current_profile_id()` — so it returns
 * exactly one row and the row is theirs. No capability is involved, and none
 * could be: `clients:view` means "read the directory" everywhere else.
 *
 * ## What is deliberately absent
 *
 * No loan balance, no repayment history, no expiry date, no penalties. Those
 * are later phases, and the page says so rather than rendering a zero that a
 * borrower might read as "I owe nothing".
 *
 * No National Identification Number either, and that is not an oversight. The
 * policy on `client_identities` has no self-clause: the borrower already knows
 * their own number, the portal gains nothing by reproducing it, and a page that
 * never displays one cannot leak one.
 *
 * No remarks. Those are the notes staff write *about* the borrower, and the
 * policy keeps them out of reach here.
 *
 * A signed-in borrower with no linked client record is a normal state — staff
 * created their login before attaching it, or they are staff with no client
 * record of their own. The page handles it without an error.
 */
export default async function PortalPage() {
  const context = await guardPermission(ROUTES.portal, 'portal:view');
  const client = await getOwnClientRecord(context.profileId);

  const photoUrl = await signedDocumentUrl('clients', client?.photoPath ?? null);
  const firstName = context.fullName.split(' ')[0] ?? context.fullName;

  return (
    <div className="min-w-0 space-y-5">
      <header className="min-w-0">
        <h1 className="break-words">Welcome, {firstName}</h1>
        <p className="text-text-muted mt-1 text-sm">Your account with us.</p>
      </header>

      {client !== null ? (
        <Card className="min-w-0">
          <div className="flex flex-col gap-4 sm:flex-row">
            {photoUrl !== null ? (
              /* eslint-disable-next-line @next/next/no-img-element --
                 A one-minute signed URL; see components/clients/document-panel.tsx. */
              <img
                src={photoUrl}
                alt="Your photograph"
                className="border-border size-24 shrink-0 rounded-lg border object-cover"
              />
            ) : null}

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="min-w-0 text-base break-words">{client.fullName}</h2>
                <ClientStatusBadge status={client.status} />
              </div>

              <dl className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2">
                <div className="min-w-0">
                  <dt className="text-text-muted text-sm">Client number</dt>
                  <dd className="font-mono break-words">{client.clientNumber}</dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-text-muted text-sm">Phone</dt>
                  <dd className="break-words">{formatUgandanPhoneLocal(client.phone)}</dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-text-muted text-sm">Occupation</dt>
                  <dd className="break-words">{client.occupation}</dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-text-muted text-sm">Location</dt>
                  <dd className="break-words">
                    {client.villageArea}, {client.district}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-text-muted text-sm">Registered</dt>
                  <dd className="break-words">
                    {formatRecordedDate(client.registeredAt)}
                  </dd>
                </div>
              </dl>

              <p className="text-text-muted mt-4 text-sm">
                If any of this is wrong, please tell our staff and they will correct it.
              </p>
            </div>
          </div>
        </Card>
      ) : null}

      <Card>
        <div className="flex gap-3">
          <span className="bg-info-surface flex size-10 shrink-0 items-center justify-center rounded-lg">
            <Construction aria-hidden="true" className="text-info size-5" />
          </span>
          <div className="min-w-0 space-y-3">
            <div>
              <h2 className="text-base">Your loan details are being prepared</h2>
              <p className="text-text-muted mt-1 text-sm">
                {client === null
                  ? 'Your account is set up and you can sign in. Your client record is not linked to this login yet — please speak to our staff.'
                  : 'Your details are on record, but loan information is not available here yet. Please continue to speak to our staff about your balance and repayments in the meantime.'}
              </p>
            </div>

            <div>
              <h3 className="text-sm font-semibold">What you will see here</h3>
              <ul className="text-text-muted mt-1.5 list-disc space-y-1 pl-5 text-sm">
                <li>Your current loan and how much is left to pay</li>
                <li>Your repayment schedule and the next amount due</li>
                <li>Every payment you have made, with its receipt number</li>
              </ul>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
