import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ClientForm } from '@/components/clients/client-form';
import { ClientIdentityForm } from '@/components/clients/client-identity-form';
import { Card } from '@/components/ui/card';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { getClient, getClientIdentity } from '@/lib/data/clients';

export const metadata = { title: 'Edit client' };

/**
 * Edit a client's ordinary details.
 *
 * The identity number has its own form below, because changing it needs two
 * capabilities rather than one — `clients:view_nin` as well as
 * `clients:update`. A Secretary/Treasurer may use the form above and not the
 * one below, which is the practical shape of the rule.
 *
 * Status, client number, portal linkage and documents are absent entirely:
 * each is changed from the client's page under its own capability.
 */
export default async function EditClientPage({
  params,
}: {
  readonly params: Promise<{ readonly clientId: string }>;
}) {
  const { clientId } = await params;
  const context = await guardPermission(
    `${ROUTES.clients}/${clientId}/edit`,
    'clients:update',
  );

  const client = await getClient(clientId);

  if (client === null) notFound();

  const canSeeNin = contextCan(context, 'clients:view_nin');
  const identity = canSeeNin ? await getClientIdentity(clientId) : null;

  return (
    <div className="min-w-0 space-y-6">
      <div className="min-w-0">
        <Link
          href={`${ROUTES.clients}/${client.id}`}
          className="text-accent focus-visible:outline-accent text-sm underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          ← {client.clientNumber}
        </Link>
        <h1 className="text-text mt-2 text-2xl font-semibold break-words">
          Edit {client.fullName}
        </h1>
      </div>

      <ClientForm
        client={client}
        // The registration form's NIN field is for a new record. Here the
        // number is edited separately below, so it is omitted from the main
        // form rather than offered twice.
        canRecordNin={false}
        canUploadDocuments={false}
      />

      {canSeeNin ? (
        <section aria-labelledby="identity-heading" className="min-w-0 space-y-3">
          <h2 id="identity-heading" className="text-text text-lg font-semibold">
            Identification
          </h2>
          <Card>
            <ClientIdentityForm clientId={client.id} currentNin={identity?.nin ?? null} />
          </Card>
        </section>
      ) : null}
    </div>
  );
}
