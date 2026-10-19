'use client';

import { SearchX } from 'lucide-react';

import {
  DataTable,
  NotRecorded,
  TableCell,
  TableHead,
  TableLead,
  TableRow,
} from '@/components/ui/data-table';
import { DateValue } from '@/components/ui/data-value';
import { Money } from '@/components/ui/money';
import { RegisterFilters, RegisterPagination } from '@/components/ui/register';
import { RowActions } from '@/components/ui/row-actions';
import { RowLink } from '@/components/ui/row-link';
import { SortHeader, ariaSortFor, type SortDirection } from '@/components/ui/sort-header';
import { StageText, StatusText } from '@/components/ui/status-text';
import { EmptyState } from '@/components/ui/states';
import { loanRowActions } from './loan-row-actions';
import {
  LOAN_STATUS_LABELS,
  LOAN_STATUS_DESCRIPTIONS,
  LOAN_WORKFLOW_ROW_LABELS,
  LOAN_WORKFLOW_LABELS,
  LOAN_WORKFLOW_STAGES,
  type LoanStatus,
  type LoanWorkflowStage,
} from '@/lib/domain/loan';
import { formatMonths } from '@/lib/domain/duration';
import { toUgx } from '@/lib/domain/money';
import { formatBps, toBps } from '@/lib/domain/rate';
import type { StatusTone } from '@/components/ui/status-text';
import type { LoanPage } from '@/lib/data/loans';

/**
 * The loan register.
 *
 * ## Every value is written out
 *
 * `1 month`, not `1 mo`. `Awaiting disbursement`, not `Awaiting Disb…`. The
 * three characters an abbreviation saves are three characters the reader has
 * to decode, on the screen a loan officer has open while a borrower waits.
 * Where a full value does not fit, the column's minimum width grows and the
 * table scrolls inside its own panel — the font never shrinks and the words
 * are never cut.
 *
 * ## Status and stage are text, not pills
 *
 * Each row used to carry two filled uppercase capsules. Twenty rows is forty
 * of them, and they were louder than the money. A status is a fact about the
 * row, so it is set at the row's own size in a restrained colour, and the
 * colour is a second channel — the label always says it in words.
 *
 * Status and stage agree on most rows (an active loan is at the active
 * stage), so the stage is quiet by default and only takes a tone where it
 * says something the status does not: arrears and a grace period.
 *
 * ## What the columns are
 *
 * Nine and the actions menu. The total repayable is deliberately not among
 * them — it is on the loan's own page, with the schedule that produces it,
 * and the register is for finding a loan rather than for reading its
 * arithmetic.
 *
 * All ten are shown at every desktop width, and the table scrolls inside its
 * own panel where they do not fit. The brief prefers that to dropping a
 * column: a register that quietly omits the interest rate on a laptop is one
 * a reader cannot trust to be complete. Their floors come to about 1,180px,
 * which is exactly the content area of a 1440px screen — a 1366px laptop
 * scrolls by roughly one column's width, and nothing wider scrolls at all.
 */

/** How much attention a status asks for. Four tones, not six colours. */
const STATUS_TONES: Readonly<Record<LoanStatus, StatusTone>> = {
  draft: 'neutral',
  pending_approval: 'attention',
  approved: 'positive',
  active: 'positive',
  cleared: 'positive',
  cancelled: 'critical',
};

/**
 * The stage is quiet unless it says something the status does not.
 *
 * An active loan at the active stage would be painted green twice. Arrears
 * and a grace period are the two stages a status cannot tell you about, so
 * they are the two that carry a colour.
 */
const STAGE_TONES: Partial<Record<LoanWorkflowStage, StatusTone>> = {
  arrears: 'critical',
  grace_period: 'attention',
  rejected: 'critical',
  withdrawn: 'critical',
};

export function LoanRegister({
  page,
  filter,
  products,
  can,
}: {
  readonly page: LoanPage;
  readonly filter: {
    readonly query: string;
    readonly stage: string;
    readonly productId: string;
    readonly status: string;
    readonly sort: string | null;
    readonly dir: SortDirection;
  };
  /**
   * Phase 13. The products the register can be sliced by. Read server-side,
   * so a product nobody may see is a product nobody can filter on.
   */
  readonly products: readonly { readonly id: string; readonly name: string }[];
  /**
   * Which capabilities the signed-in person holds, resolved on the server.
   *
   * Passed as a plain set rather than the auth context: this is a client
   * component, and the context carries more about the person than a register
   * has any business shipping to the browser.
   */
  readonly can: Readonly<Record<string, boolean>>;
}) {
  const filtered =
    filter.query !== '' ||
    filter.stage !== '' ||
    filter.productId !== '' ||
    filter.status !== '';

  const held = (permission: string): boolean => can[permission] === true;

  return (
    <div className="min-w-0 space-y-4">
      <RegisterFilters
        search={{
          id: 'loan-search',
          label: 'Search',
          param: 'q',
          value: filter.query,
          placeholder: 'Search loan number, client name or client number…',
        }}
        selects={[
          {
            id: 'loan-product',
            label: 'Loan product',
            param: 'productId',
            value: filter.productId,
            options: [
              { value: '', label: 'All products' },
              ...products.map((product) => ({
                value: product.id,
                label: product.name,
              })),
            ],
          },
          {
            id: 'loan-stage',
            label: 'Status',
            param: 'stage',
            value: filter.stage,
            options: [
              { value: '', label: 'All statuses' },
              ...LOAN_WORKFLOW_STAGES.map((stage) => ({
                value: stage,
                label: LOAN_WORKFLOW_LABELS[stage],
              })),
            ],
          },
        ]}
      />

      {page.loans.length === 0 ? (
        <EmptyState
          icon={filtered ? SearchX : undefined}
          title={filtered ? 'No loans match this view' : 'No loans recorded yet'}
          description={
            filtered
              ? 'Clear the search, or choose a different product or status, to widen the result.'
              : 'Loans appear here as soon as the first application is taken.'
          }
        />
      ) : (
        <>
          <ul className="space-y-3 md:hidden">
            {page.loans.map((loan) => (
              <li key={loan.id}>
                <RowLink
                  href={`/loans/${loan.id}`}
                  className="record-surface focus-visible:outline-accent block rounded-lg p-4 focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-text font-medium break-words">
                        {loan.clientName}
                      </p>
                      <p className="text-text-muted font-mono text-sm">
                        {loan.loanNumber}
                      </p>
                    </div>
                    <StatusText tone={STATUS_TONES[loan.status]}>
                      {LOAN_STATUS_LABELS[loan.status]}
                    </StatusText>
                  </div>

                  <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                    <div className="min-w-0">
                      <dt className="text-text-muted">Principal</dt>
                      <dd className="text-text">
                        <Money amount={toUgx(loan.principalAmount)} />
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-text-muted">Total repayable</dt>
                      <dd className="text-text">
                        {loan.totalExpectedRepayment === 0 ? (
                          <NotRecorded />
                        ) : (
                          <Money amount={toUgx(loan.totalExpectedRepayment)} />
                        )}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-text-muted">Interest rate</dt>
                      <dd className="text-text">
                        {formatBps(toBps(loan.interestRateBps))}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-text-muted">Loan term</dt>
                      <dd className="text-text">{formatMonths(loan.loanTermMonths)}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-text-muted">Start date</dt>
                      <dd className="text-text">
                        <DateValue value={loan.createdAt} />
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-text-muted">Stage</dt>
                      <dd className="text-text">
                        {LOAN_WORKFLOW_ROW_LABELS[loan.workflowStage]}
                      </dd>
                    </div>
                    <div className="col-span-2 min-w-0">
                      <dt className="text-text-muted">Loan product</dt>
                      <dd className="text-text break-words">{loan.productName}</dd>
                    </div>
                  </dl>

                  {loan.arrearsAmount !== null && loan.arrearsAmount > 0 ? (
                    <p className="text-danger mt-2 text-sm">
                      <Money amount={toUgx(loan.arrearsAmount)} /> in arrears
                    </p>
                  ) : null}
                </RowLink>
              </li>
            ))}
          </ul>

          <div className="border-border bg-surface hidden min-w-0 rounded-lg border shadow-xs md:block">
            <DataTable
              caption="Loan register"
              containerClassName="rounded-b-none border-0 shadow-none"
            >
              <thead>
                <tr>
                  <TableHead
                    width="ref"
                    ariaSort={ariaSortFor('loan_number', filter.sort, filter.dir)}
                  >
                    <SortHeader
                      column="loan_number"
                      active={filter.sort}
                      direction={filter.dir}
                    >
                      Loan no.
                    </SortHeader>
                  </TableHead>
                  <TableHead
                    width="name"
                    ariaSort={ariaSortFor('client_name', filter.sort, filter.dir)}
                  >
                    <SortHeader
                      column="client_name"
                      active={filter.sort}
                      direction={filter.dir}
                    >
                      Client
                    </SortHeader>
                  </TableHead>
                  <TableHead
                    width="product"
                    ariaSort={ariaSortFor('product_name', filter.sort, filter.dir)}
                  >
                    <SortHeader
                      column="product_name"
                      active={filter.sort}
                      direction={filter.dir}
                    >
                      Loan product
                    </SortHeader>
                  </TableHead>
                  <TableHead
                    width="money"
                    align="numeric"
                    ariaSort={ariaSortFor('principal_amount', filter.sort, filter.dir)}
                  >
                    <SortHeader
                      column="principal_amount"
                      active={filter.sort}
                      direction={filter.dir}
                      defaultDirection="desc"
                      numeric
                    >
                      Principal
                    </SortHeader>
                  </TableHead>
                  <TableHead width="rate">Interest rate</TableHead>
                  <TableHead width="term">Loan term</TableHead>
                  <TableHead
                    width="date"

                    ariaSort={ariaSortFor('created_at', filter.sort, filter.dir)}
                  >
                    <SortHeader
                      column="created_at"
                      active={filter.sort}
                      direction={filter.dir}
                      defaultDirection="desc"
                    >
                      Start date
                    </SortHeader>
                  </TableHead>
                  <TableHead
                    width="status"
                    ariaSort={ariaSortFor('status', filter.sort, filter.dir)}
                  >
                    <SortHeader
                      column="status"
                      active={filter.sort}
                      direction={filter.dir}
                    >
                      Status
                    </SortHeader>
                  </TableHead>
                  <TableHead width="status-wide">Stage</TableHead>
                  <TableHead width="actions" align="right" stickyEnd>
                    Actions
                  </TableHead>
                </tr>
              </thead>
              <tbody>
                {page.loans.map((loan) => (
                  <TableRow key={loan.id}>
                    <TableCell width="ref" className="font-mono">
                      <RowLink
                        href={`/loans/${loan.id}`}
                        className="text-accent focus-visible:outline-accent font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                      >
                        {loan.loanNumber}
                      </RowLink>
                    </TableCell>
                    <TableCell width="name" wrap="wrap">
                      <TableLead
                        primary={loan.clientName}
                        secondary={loan.clientNumber}
                      />
                    </TableCell>
                    <TableCell width="product" wrap="wrap">
                      <TableLead
                        primary={loan.productName}
                        secondary={loan.productCode}
                      />
                    </TableCell>
                    <TableCell width="money" align="numeric">
                      <Money amount={toUgx(loan.principalAmount)} />
                    </TableCell>
                    <TableCell width="rate" className="text-text">
                      {formatBps(toBps(loan.interestRateBps))}
                    </TableCell>
                    <TableCell width="term" className="text-text">
                      {formatMonths(loan.loanTermMonths)}
                    </TableCell>
                    <TableCell width="date" className="text-text">
                      <DateValue value={loan.createdAt} />
                    </TableCell>
                    <TableCell width="status">
                      <StatusText
                        tone={STATUS_TONES[loan.status]}
                        title={LOAN_STATUS_DESCRIPTIONS[loan.status]}
                      >
                        {LOAN_STATUS_LABELS[loan.status]}
                      </StatusText>
                    </TableCell>
                    <TableCell width="status-wide">
                      <StageText tone={STAGE_TONES[loan.workflowStage] ?? 'quiet'}>
                        {LOAN_WORKFLOW_ROW_LABELS[loan.workflowStage]}
                      </StageText>
                    </TableCell>
                    <TableCell width="actions" align="right" stickyEnd>
                      <RowActions
                        label={`loan ${loan.loanNumber}`}
                        actions={loanRowActions({
                          loanId: loan.id,
                          status: loan.status,
                          can: held,
                        })}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </tbody>
            </DataTable>

            <RegisterPagination
              page={page.page}
              pageSize={page.pageSize}
              rows={page.loans.length}
              hasMore={page.hasMore}
              total={page.total}
              noun="loan"
            />
          </div>

          <div className="md:hidden">
            <RegisterPagination
              page={page.page}
              pageSize={page.pageSize}
              rows={page.loans.length}
              hasMore={page.hasMore}
              total={page.total}
              noun="loan"
            />
          </div>
        </>
      )}
    </div>
  );
}
