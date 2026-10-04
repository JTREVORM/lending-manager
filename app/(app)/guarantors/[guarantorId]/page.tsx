import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import {
  getGuarantor,
  getGuarantorNin,
  listGuarantorClients,
} from '@/lib/data/guarantors';
import { signedDocumentUrl } from '@/lib/storage/documents';
import {
  SEX_LABELS,
  formatCalendarDate,
  formatRecordedDate,
  maskNin,
} from '@/lib/domain/client';
import { PhoneValue } from '@/components/ui/data-value';

export const metadata = { title: 'Guarantor' };

/**
 * One guarantor's record, and the clients they stand for.
 *
 * The client list is the point of this page: it answers "how much is this
 * person already on the hook for", which is invisible if the same individual
 * has been entered three times under three client records.
 *
 * No loan-related exposure is shown, because loans do not exist yet. When they
 * do, Phase 4 must snapshot the guarantor details it relied on rather than
 * reading through to this record — otherwise a guarantor changing their phone
 * number in 2027 would rewrite what the business will claim it was told in
 * 2026.
 */
export default async function GuarantorDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly guarantorId: string }>;
}) {
  const { guarantorId } = await params;
  const context = await guardPermission(
    `${ROUTES.guarantors}/${guarantorId}`,
    'guarantors:view',
  );

  const guarantor = await getGuarantor(guarantorId);

  if (guarantor === null) notFound();

  const canSeeNin = contextCan(context, 'guarantors:view_nin');

  const [nin, clients, photoUrl] = await Promise.all([
    canSeeNin ? getGuarantorNin(guarantorId) : Promise.resolve(null),
    listGuarantorClients(guarantorId),
    signedDocumentUrl('guarantors', guarantor.photoPath),
  ]);

  const active = clients.filter((link) => link.active);
  const previous = clients.filter((link) => !link.active);

  return (
    <div className="min-w-0 space-y-6">
      <div className="min-w-0">
        <Link
          href={ROUTES.guarantors}
          className="text-accent focus-visible:outline-accent text-sm underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          ← Guarantors
        </Link>

        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-text min-w-0 text-2xl font-semibold break-words">
            {guarantor.fullName}
          </h1>

          {contextCan(context, 'guarantors:update') ? (
            <Link
              href={`${ROUTES.guarantors}/${guarantor.id}/edit`}
              className="border-border text-text focus-visible:outline-accent inline-flex min-h-11 shrink-0 items-center justify-center rounded-lg border px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              Edit
            </Link>
          ) : null}
        </div>
      </div>

      <section aria-labelledby="guarantor-profile" className="min-w-0 space-y-3">
        <h2 id="guarantor-profile" className="text-text text-lg font-semibold">
          Profile
        </h2>

        <Card>
          <div className="flex flex-col gap-4 sm:flex-row">
            {photoUrl !== null ? (
              /* eslint-disable-next-line @next/next/no-img-element --
                 A one-minute signed URL; see components/clients/document-panel.tsx. */
              <img
                src={photoUrl}
                alt="Guarantor photograph"
                className="border-border h-32 w-32 shrink-0 rounded-lg border object-cover"
              />
            ) : null}

            <dl className="grid min-w-0 flex-1 gap-4 sm:grid-cols-2">
              <Detail label="Phone">
                <PhoneValue value={guarantor.phone} />
              </Detail>
              <Detail label="Alternative phone">
                {guarantor.alternativePhone === null ? (
                  '—'
                ) : (
                  <PhoneValue value={guarantor.alternativePhone} />
                )}
              </Detail>
              <Detail label="Sex">{SEX_LABELS[guarantor.sex]}</Detail>
              <Detail label="Date of birth">
                {formatCalendarDate(guarantor.dateOfBirth)}
              </Detail>
              <Detail label="Occupation">{guarantor.occupation}</Detail>
              <Detail label="Location">
                {guarantor.location}
                {guarantor.district === null ? '' : `, ${guarantor.district}`}
              </Detail>
              <Detail label="Registered">
                {formatRecordedDate(guarantor.createdAt)}
              </Detail>
              <Detail label="National Identification Number">
                {!canSeeNin ? (
                  <span className="text-text-muted">Restricted.</span>
                ) : nin === null ? (
                  '—'
                ) : (
                  <details className="min-w-0">
                    <summary className="text-text min-h-11 cursor-pointer font-mono">
                      {maskNin(nin)}
                      <span className="text-accent ml-2 font-sans text-sm">Show</span>
                    </summary>
                    <span className="text-text font-mono break-all">{nin}</span>
                  </details>
                )}
              </Detail>
            </dl>
          </div>
        </Card>
      </section>

      <section aria-labelledby="guarantor-clients" className="min-w-0 space-y-3">
        <h2 id="guarantor-clients" className="text-text text-lg font-semibold">
          Clients guaranteed
        </h2>

        {active.length === 0 ? (
          <Card>
            <p className="text-text-muted">
              This guarantor does not currently stand for any client.
            </p>
          </Card>
        ) : (
          <ul className="space-y-3">
            {active.map((link) => (
              <li
                key={link.linkId}
                className="border-border bg-surface min-w-0 rounded-xl border p-4"
              >
                <Link
                  href={`${ROUTES.clients}/${link.clientId}`}
                  className="text-accent focus-visible:outline-accent font-medium break-words underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  {link.fullName}
                </Link>
                <p className="text-text-muted font-mono text-sm">{link.clientNumber}</p>
                <p className="text-text-muted text-sm break-words">
                  {link.relationshipToClient} · attached{' '}
                  {formatRecordedDate(link.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        )}

        {previous.length > 0 ? (
          <details className="border-border bg-surface rounded-xl border p-4">
            <summary className="text-text min-h-11 cursor-pointer text-sm font-medium">
              Previously guaranteed ({String(previous.length)})
            </summary>
            <ul className="mt-3 space-y-2">
              {previous.map((link) => (
                <li key={link.linkId} className="min-w-0 text-sm">
                  <span className="text-text-muted break-words">
                    {link.fullName} ({link.clientNumber})
                  </span>{' '}
                  <Badge tone="neutral">Detached</Badge>
                  {link.detachedReason !== null ? (
                    <p className="text-text-muted break-words">
                      Reason: {link.detachedReason}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>
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
