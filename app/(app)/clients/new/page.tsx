import { UserPlus } from 'lucide-react';

import { ClientForm } from '@/components/clients/client-form';
import { PageHeader } from '@/components/ui/page-header';
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
      <PageHeader
        eyebrow="Borrower Register"
        icon={UserPlus}
        back={{ href: ROUTES.clients, label: 'Clients' }}
        title="Register a client"
        description="A client number is issued automatically when the record is saved."
      />

      <ClientForm
        canRecordNin={contextCan(context, 'clients:view_nin')}
        canUploadDocuments={contextCan(context, 'clients:documents')}
      />
    </div>
  );
}
