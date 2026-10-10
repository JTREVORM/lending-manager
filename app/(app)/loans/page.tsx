import { Banknote } from 'lucide-react';

import { LoanRegister } from '@/components/loans/loan-register';
import { LoanWorkflowTabs } from '@/components/loans/loan-workflow-tabs';
import { ActionLink, PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { listLoans } from '@/lib/data/loans';
import { getLoanProducts } from '@/lib/data/products';
import {
  LOAN_WORKFLOW_DESCRIPTIONS,
  LOAN_WORKFLOW_LABELS,
  isLoanWorkflowStage,
} from '@/lib/domain/loan';
import { loanSearchSchema } from '@/lib/validation/loan';

export const metadata = { title: 'Loans' };

/**
 * The loan register, and the eleven views over it.
 *
 * Phase 13 reorganises this screen around the workflow rather than around the
 * lifecycle status. Draft applications, pending approval, approved, awaiting
 * disbursement, active, grace, arrears, cleared, rejected and cancelled are
 * each a filter on `loan_workflow_register` — one query, eleven `where`
 * clauses, so no two views can disagree about what "in arrears" means.
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
    stage: typeof params.stage === 'string' ? params.stage : '',
    productId: typeof params.productId === 'string' ? params.productId : '',
    status: typeof params.status === 'string' ? params.status : '',
    clientId: typeof params.clientId === 'string' ? params.clientId : '',
    page: typeof params.page === 'string' ? params.page : '1',
  });

  // A malformed filter falls back to the whole register rather than erroring:
  // the filter is a convenience, not a control.
  const filter = parsed.success
    ? parsed.data
    : {
        query: null,
        stage: null,
        productId: null,
        status: null,
        clientId: null,
        page: 1,
      };

  const stage = isLoanWorkflowStage(filter.stage) ? filter.stage : null;

  const [page, products] = await Promise.all([
    listLoans({ ...filter, stage }),
    getLoanProducts(),
  ]);

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Lending Portfolio"
        icon={Banknote}
        title="Loans"
        description={
          stage === null
            ? 'Every application and every loan. Search by loan number, client name or client number.'
            : LOAN_WORKFLOW_DESCRIPTIONS[stage]
        }
        primaryAction={
          contextCan(context, 'loans:create') ? (
            <ActionLink href={`${ROUTES.loans}/new`}>New application</ActionLink>
          ) : null
        }
        secondaryActions={
          /*
            `prefetch={false}`, unlike the primary action beside it. Starting
            an application is the thing somebody opens this screen to do, so
            prefetching it buys an instant form; the product breakdown is a
            monthly management read, and prefetching it on every visit to the
            register spends a page of airtime on a screen most staff open
            once. Measured: the register costs 55 requests with this off and
            57 with it on, against a budget of 55.
          */
          <ActionLink
            href={`${ROUTES.loans}/by-product`}
            variant="secondary"
            prefetch={false}
          >
            By product
          </ActionLink>
        }
      />

      <LoanWorkflowTabs stage={stage ?? ''} />

      {stage !== null ? <h2 className="sr-only">{LOAN_WORKFLOW_LABELS[stage]}</h2> : null}

      <LoanRegister
        page={page}
        filter={{
          query: filter.query ?? '',
          stage: stage ?? '',
          productId: filter.productId ?? '',
        }}
        products={products.map((product) => ({
          id: product.productId,
          name: product.name,
        }))}
      />
    </div>
  );
}
