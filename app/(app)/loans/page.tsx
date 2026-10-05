import { LoanRegister } from '@/components/loans/loan-register';
import { ActionLink, PageHeader } from '@/components/ui/page-header';
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
      <PageHeader
        title="Loans"
        description="Search by loan number, client name or client number."
        primaryAction={
          contextCan(context, 'loans:create') ? (
            <ActionLink href={`${ROUTES.loans}/new`}>New loan</ActionLink>
          ) : null
        }
      />

      <LoanRegister
        page={page}
        filter={{ query: filter.query ?? '', status: filter.status ?? '' }}
      />
    </div>
  );
}
