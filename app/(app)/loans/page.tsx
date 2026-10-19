import { Banknote } from 'lucide-react';

import { LoanRegister } from '@/components/loans/loan-register';
import { ActionLink, PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { listLoans } from '@/lib/data/loans';
import { getLoanProducts } from '@/lib/data/products';
import {
  LOAN_REGISTER_TITLE,
  LOAN_WORKFLOW_DESCRIPTIONS,
  type LoanWorkflowStage,
  isLoanWorkflowStage,
  loanRegisterTitle,
} from '@/lib/domain/loan';
import { DEFAULT_PAGE_SIZE } from '@/lib/domain/pagination';
import { loanSearchSchema } from '@/lib/validation/loan';

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * The filter a request asks for.
 *
 * A malformed filter falls back to the whole register rather than erroring:
 * the filter is a convenience, not a control. Row Level Security decides what
 * the query may return either way.
 */
function readFilter(params: SearchParams) {
  const parsed = loanSearchSchema.safeParse({
    query: typeof params.q === 'string' ? params.q : '',
    stage: typeof params.stage === 'string' ? params.stage : '',
    productId: typeof params.productId === 'string' ? params.productId : '',
    status: typeof params.status === 'string' ? params.status : '',
    clientId: typeof params.clientId === 'string' ? params.clientId : '',
    page: typeof params.page === 'string' ? params.page : '1',
    sort: typeof params.sort === 'string' ? params.sort : undefined,
    dir: typeof params.dir === 'string' ? params.dir : undefined,
    pageSize: typeof params.pageSize === 'string' ? params.pageSize : undefined,
  });

  return parsed.success
    ? parsed.data
    : {
        query: null,
        stage: null,
        productId: null,
        status: null,
        clientId: null,
        page: 1,
        sort: null,
        dir: 'desc' as const,
        pageSize: DEFAULT_PAGE_SIZE,
      };
}

function readStage(params: SearchParams): LoanWorkflowStage | null {
  const { stage } = readFilter(params);
  return isLoanWorkflowStage(stage) ? stage : null;
}

/**
 * The document title follows the heading.
 *
 * Phase 21. A stage view is a view of this register, not a page of its own, so
 * a browser tab, a bookmark and a reading-list entry name the stage that is
 * open — "Arrears", not "Loans" for all eleven. It reads the stage through the
 * same `readFilter` the page does, so the tab and the heading cannot disagree.
 */
export function generateMetadata({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}): Promise<{ readonly title: string }> {
  return searchParams.then((params) => ({ title: loanRegisterTitle(readStage(params)) }));
}

/**
 * The loan register.
 *
 * Phase 13 reorganised this screen around the workflow rather than around the
 * lifecycle status. Draft applications, pending approval, approved, awaiting
 * disbursement, active, grace, arrears, cleared, rejected and cancelled are
 * each a filter on `loan_workflow_register` — one query, ten `where` clauses,
 * so no two views can disagree about what "in arrears" means.
 *
 * Phase 21 removed the horizontal strip of workflow tabs that sat above the
 * register. The sidebar's Loan Management module already lists the register
 * and all ten stages, so the strip was a second copy of one navigation, and
 * the only one of the two that could fall out of step with it. One screen,
 * one register, one query: a stage narrows the heading and the rows, and
 * nothing else about the page changes.
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
  readonly searchParams: Promise<SearchParams>;
}) {
  const context = await guardPermission(ROUTES.loans, 'loans:view');
  const params = await searchParams;

  const filter = readFilter(params);
  const stage = isLoanWorkflowStage(filter.stage) ? filter.stage : null;

  const [page, products] = await Promise.all([
    listLoans({ ...filter, stage }),
    getLoanProducts(),
  ]);

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        /*
          The eyebrow names the area a screen belongs to. On a stage view that
          area *is* the register, which is also how the heading beneath it
          reads as "Loan Register → Arrears" rather than as a page of its own.
        */
        eyebrow={stage === null ? 'Lending Portfolio' : LOAN_REGISTER_TITLE}
        icon={Banknote}
        title={loanRegisterTitle(stage)}
        /*
          The one thing the removed tab strip did that the sidebar does not do
          on a phone, where the sidebar is behind a menu button: offer the way
          back to the whole register in a tap. A link, not a tab row.
        */
        {...(stage === null
          ? {}
          : { back: { href: ROUTES.loans, label: LOAN_REGISTER_TITLE } })}
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

      {/*
        No `sr-only` heading for the stage any more: the stage *is* the
        heading, so announcing it twice would be the screen-reader equivalent
        of the duplicate navigation this phase removed.
      */}
      <LoanRegister
        page={page}
        filter={{
          query: filter.query ?? '',
          stage: stage ?? '',
          productId: filter.productId ?? '',
          status: filter.status ?? '',
          sort: filter.sort,
          dir: filter.dir,
        }}
        products={products.map((product) => ({
          id: product.productId,
          name: product.name,
        }))}
        /*
          Resolved here, on the server, and shipped as four booleans.

          The row menu needs to know what this person may do; it does not
          need the auth context, which carries their identity, their branch
          and their whole permission set. Four answers to four questions is
          the smallest thing that does the job, and hiding an entry is a
          courtesy either way — every destination re-checks its own
          permission and Row Level Security applies underneath.
        */
        can={{
          'loans:update_draft': contextCan(context, 'loans:update_draft'),
          'loans:submit': contextCan(context, 'loans:submit'),
          'loans:approve': contextCan(context, 'loans:approve'),
          'loans:disburse': contextCan(context, 'loans:disburse'),
          'payments:create': contextCan(context, 'payments:create'),
        }}
      />
    </div>
  );
}
