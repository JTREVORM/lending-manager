import Link from 'next/link';

import { LoanRegister } from '@/components/loans/loan-register';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { listLoans } from '@/lib/data/loans';
import { loanSearchSchema } from '@/lib/validation/loan';

export const metadata = { title: 'Loans' };

/**
 * The loan register.
 *
 * Guarded three times: the proxy refuses an anonymous request, the layout
 * applies the route requirement, and this page states `loans:view` again so
 * the requirement stays visible where it is relied on. Beneath all of it, Row
 * Level Security means a caller without the capability gets no rows however
 * they ask.
 */
export default async function LoansPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await guardPermission(ROUTES.loans, 'loans:view');
  const params = await searchParams;

  const parsed = loanSearchSchema.safeParse({
    query: typeof params.q === 'string' ? params.q : '',
    status: typeof params.status === 'string' ? params.status : '',
    clientId: typeof params.clientId === 'string' ? params.clientId : '',
    page: typeof params.page === 'string' ? params.page : '1',
  });

  // A malformed filter falls back to the default view rather than erroring:
  // the filter is a convenience, not a control.
  const filter = parsed.success
    ? parsed.data
    : { query: null, status: null, clientId: null, page: 1 };

  const page = await listLoans(filter);

  return (
    <div className="min-w-0 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-text text-2xl font-semibold break-words">Loans</h1>
          <p className="text-text-muted mt-1">
            Search by loan number, client name or client number.
          </p>
        </div>

        {contextCan(context, 'loans:create') ? (
          <Link
            href={`${ROUTES.loans}/new`}
            className="bg-accent text-accent-contrast focus-visible:outline-accent inline-flex min-h-11 shrink-0 items-center justify-center rounded-lg px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            New loan
          </Link>
        ) : null}
      </div>

      <LoanRegister
        page={page}
        filter={{ query: filter.query ?? '', status: filter.status ?? '' }}
      />
    </div>
  );
}
