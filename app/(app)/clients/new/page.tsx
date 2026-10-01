import Link from 'next/link';

import { ClientForm } from '@/components/clients/client-form';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';

export const metadata = { title: 'Register a client' };

/**
 * Register a client.
 *
 * The National Identification Number section appears only for a viewer holding
 * `clients:view_nin`. That is not merely cosmetic: the policy on
 * `client_identities` would refuse the insert anyway, so showing the field to
 * a Secretary/Treasurer would be offering them work that cannot be saved.
 */
export default async function NewClientPage() {
  const context = await guardPermission(`${ROUTES.clients}/new`, 'clients:create');

  return (
    <div className="min-w-0 space-y-6">
      <div className="min-w-0">
        <Link
          href={ROUTES.clients}
          className="text-accent focus-visible:outline-accent text-sm underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          ← Clients
        </Link>
        <h1 className="text-text mt-2 text-2xl font-semibold break-words">
          Register a client
        </h1>
        <p className="text-text-muted mt-1">
          A client number is issued automatically when the record is saved.
        </p>
      </div>

      <ClientForm
        canRecordNin={contextCan(context, 'clients:view_nin')}
        canUploadDocuments={contextCan(context, 'clients:documents')}
      />
    </div>
  );
}
