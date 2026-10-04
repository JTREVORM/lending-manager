import { Construction } from 'lucide-react';

import { Card } from '@/components/ui/card';
import { ClientStatusBadge } from '@/components/clients/client-status-badge';
import { PortalPaymentHistory } from '@/components/payments/portal-payment-history';
import { PortalLoanPosition } from '@/components/delinquency/portal-loan-position';
import { listClientDelinquency } from '@/lib/data/delinquency';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { getOwnClientRecord } from '@/lib/data/clients';
import { getCompanyBranding } from '@/lib/data/company';
import { listClientPayments } from '@/lib/data/payments';
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

  // Phase 6. A borrower's own payments, through the ownership clause in the
  // policy on `loan_payments` — no capability is involved and none could be:
  // `payments:view` means "read the register" everywhere else.
  //
  // Phase 7 adds the position. Phase 6 deliberately withheld a balance here,
  // because a single figure in a self-service portal reads as a settlement
  // quote. That worry is answered by showing the *position* rather than a
  // number — what was missed, what is due today, what remains, and when the
  // loan ends — which is information a borrower who is behind needs and
  // should not have to learn from a phone call.
  const [payments, { branding }, positions] = await Promise.all([
    client === null ? Promise.resolve([]) : listClientPayments(client.id),
    getCompanyBranding(),
    client === null ? Promise.resolve([]) : listClientDelinquency(client.id),
  ]);

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

      {client !== null && positions.length > 0 ? (
        <section aria-labelledby="my-loans-heading" className="min-w-0 space-y-3">
          <h2 id="my-loans-heading" className="text-base">
            Your loans
          </h2>

          {positions.map((position) => (
            <PortalLoanPosition key={position.loanId} position={position} />
          ))}

          <p className="text-text-muted text-sm">
            These figures are what our records show today. If anything looks wrong, please
            speak to our staff — bring your receipts and we will check it with you.
          </p>
        </section>
      ) : null}

      {client !== null && payments.length > 0 ? (
        <section aria-labelledby="my-payments-heading" className="min-w-0 space-y-3">
          <h2 id="my-payments-heading" className="text-base">
            Payments you have made
          </h2>

          <PortalPaymentHistory payments={payments} timeZone={branding.timezone} />

          <p className="text-text-muted text-sm">
            Quote the receipt number if you ever need to ask about a payment. For your
            current balance or what is due next, please speak to our staff.
          </p>
        </section>
      ) : (
        <Card>
          <div className="flex gap-3">
            <span className="bg-info-surface flex size-10 shrink-0 items-center justify-center rounded-lg">
              <Construction aria-hidden="true" className="text-info size-5" />
            </span>
            <div className="min-w-0 space-y-3">
              <div>
                <h2 className="text-base">
                  {client === null
                    ? 'Your account is not linked yet'
                    : 'No payments recorded yet'}
                </h2>
                <p className="text-text-muted mt-1 text-sm">
                  {client === null
                    ? 'Your account is set up and you can sign in. Your client record is not linked to this login yet — please speak to our staff.'
                    : 'Once you make a payment it will appear here with its receipt number. Please speak to our staff about your balance and what is due next.'}
                </p>
              </div>

              <div>
                <h3 className="text-sm font-semibold">What you will see here</h3>
                <ul className="text-text-muted mt-1.5 list-disc space-y-1 pl-5 text-sm">
                  <li>Every payment you have made, with its receipt number</li>
                  <li>How much of each payment went to interest and to principal</li>
                </ul>
              </div>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
