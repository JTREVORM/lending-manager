import Link from 'next/link';

import { ClientDirectory } from '@/components/clients/client-directory';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { listClients } from '@/lib/data/clients';
import { clientSearchSchema } from '@/lib/validation/client';

export const metadata = { title: 'Clients' };

/**
 * The client directory.
 *
 * Guarded three times: the proxy refuses an anonymous request, the layout
 * applies the route requirement, and this page states `clients:view` again
 * explicitly so the requirement stays visible at the surface that depends on
 * it. Beneath all of it, Row Level Security means a caller without the
 * capability gets no rows however they ask — and a borrower gets at most their
 * own, through the identity clause rather than through a capability.
 */
export default async function ClientsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await guardPermission(ROUTES.clients, 'clients:view');
  const params = await searchParams;

  const parsed = clientSearchSchema.safeParse({
    query: typeof params.q === 'string' ? params.q : '',
    status: typeof params.status === 'string' ? params.status : '',
    page: typeof params.page === 'string' ? params.page : '1',
  });

  // A malformed filter in the URL falls back to the default view rather than
  // erroring: the filter is a convenience, not a control.
  const filter = parsed.success ? parsed.data : { query: null, status: null, page: 1 };

  const page = await listClients(filter);

  return (
    <div className="min-w-0 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-text text-2xl font-semibold break-words">Clients</h1>
          <p className="text-text-muted mt-1">
            Search by name, client number or phone number.
          </p>
        </div>

        {contextCan(context, 'clients:create') ? (
          <Link
            href={`${ROUTES.clients}/new`}
            className="bg-accent text-accent-contrast focus-visible:outline-accent inline-flex min-h-11 shrink-0 items-center justify-center rounded-lg px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Register client
          </Link>
        ) : null}
      </div>

      <ClientDirectory
        page={page}
        filter={{
          query: filter.query ?? '',
          status: filter.status ?? '',
        }}
      />
    </div>
  );
}
