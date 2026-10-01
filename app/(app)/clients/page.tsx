import { PhasePlaceholder } from '@/components/layout/phase-placeholder';

export const metadata = { title: 'Clients' };

export default function ClientsPage() {
  return (
    <PhasePlaceholder
      title="Clients"
      phase={2}
      summary="Client and guarantor records arrive with Phase 2, once authentication and the permission model are in place."
      planned={[
        'Register a client, with a Ugandan phone number as their unique identifier',
        'Issue a client number automatically (CL26001, CL26002, …)',
        'Record guarantors and link them to a client',
        'Upload identification documents to private storage',
        'Archive a client instead of deleting them, so their history is preserved',
      ]}
    />
  );
}
