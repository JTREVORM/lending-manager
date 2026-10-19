'use client';

import { RowLink } from '@/components/ui/row-link';

import {
  DataTable,
  NotRecorded,
  TableCell,
  TableHead,
  TableLead,
  TableRow,
} from '@/components/ui/data-table';
import {
  RegisterCount,
  RegisterFilters,
  RegisterPagination,
} from '@/components/ui/register';
import { EmptyState } from '@/components/ui/states';
import { Money } from '@/components/ui/money';
import { Badge } from '@/components/ui/badge';
import { DateValue } from '@/components/ui/data-value';
import { LoanStatusBadge } from './loan-status-badge';
import { LOAN_WORKFLOW_LABELS } from '@/lib/domain/loan';
import { toUgx } from '@/lib/domain/money';
import { formatBps, toBps } from '@/lib/domain/rate';
import { SearchX } from 'lucide-react';
import type { LoanPage } from '@/lib/data/loans';

/**
 * The loan register.
 *
 * ## The shape of the table
 *
 * Ten columns, each with a floor from the shared scale, so the table reaches
 * about 1,280px with every column shown. The content area is the viewport
 * less the 256px rail, so that fits a 1920px screen and not a 1366px one:
 * there the term and the rate step out — both stated in full on the loan's
 * own page — and the eight that remain come to about 1,120px against 1,070,
 * so the register scrolls by a column's width rather than by three.
 *
 * `2xl` rather than `xl` for exactly that reason: `xl` is 1280px of
 * *viewport*, which a 1366px laptop clears while still only having 1,070px
 * to draw in. The first pass used `xl` and pushed `Status` off the right
 * edge.
 *
 * Three columns step out, not two. With the term and the rate gone the table
 * still came to 1,116px and clipped `Stage` — and `Stage` is the bucket the
 * whole register is organised around, the thing the sidebar navigates by.
 * The start date went with them: it is a date on a row a reader opens for
 * the date, where `Stage` is what they are scanning the register to find. At
 * 1,012px the laptop now shows every remaining column with nothing to
 * scroll.
 *
 * What the table never does is squeeze a borrower's name until it folds,
 * which is what `w-full` auto layout did to this screen before.
 *
 * Name and product clamp at two lines and carry their full value as a
 * tooltip; every row links to the loan, which holds both in full. Nothing
 * that identifies the loan — its number, its client's number, its figures —
 * is ever truncated.
 *
 * Cards on a phone, the table from `md` up.
 *
 * ## Zero and absent are different facts
 *
 * `totalExpectedRepayment` is `0` only while a loan's schedule has not been
 * computed — the database forbids a partial total, and from approval onward
 * requires one at least as large as the principal. So a zero there means "not
 * worked out yet", and the register says that rather than printing `UGX 0`
 * at a borrower who owes nothing of the sort.
 */
export function LoanRegister({
  page,
  filter,
  products,
}: {
  readonly page: LoanPage;
  readonly filter: {
    readonly query: string;
    readonly stage: string;
    readonly productId: string;
  };
  /**
   * Phase 13. The products the register can be sliced by. Read server-side,
   * so a product nobody may see is a product nobody can filter on.
   */
  readonly products: readonly { readonly id: string; readonly name: string }[];
}) {
  const filtered = filter.query !== '' || filter.stage !== '' || filter.productId !== '';

  return (
    <div className="min-w-0 space-y-4">
      <RegisterFilters
        search={{
          id: 'loan-search',
          label: 'Search',
          param: 'q',
          value: filter.query,
          placeholder: 'Loan number, client name or client number',
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
        ]}
        summary={
          <RegisterCount
            shown={page.loans.length}
            page={page.page}
            hasMore={page.hasMore}
            noun="loan"
          />
        }
      />

      {page.loans.length === 0 ? (
        <EmptyState
          icon={filtered ? SearchX : undefined}
          title={filtered ? 'No loans match this view' : 'No loans recorded yet'}
          description={
            filtered
              ? 'Clear the search or choose a different product to widen the result.'
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
                    <LoanStatusBadge status={loan.status} />
                  </div>

                  <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                    <div className="min-w-0">
                      <dt className="text-text-muted">Principal</dt>
                      <dd className="text-text">
                        <Money amount={toUgx(loan.principalAmount)} />
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-text-muted">Repayable</dt>
                      <dd className="text-text">
                        {loan.totalExpectedRepayment === 0 ? (
                          <NotRecorded />
                        ) : (
                          <Money amount={toUgx(loan.totalExpectedRepayment)} />
                        )}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-text-muted">Period</dt>
                      <dd className="text-text">
                        {String(loan.loanTermMonths)}{' '}
                        {loan.loanTermMonths === 1 ? 'month' : 'months'}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-text-muted">Started</dt>
                      <dd className="text-text">
                        <DateValue value={loan.createdAt} />
                      </dd>
                    </div>
                    <div className="col-span-2 min-w-0">
                      <dt className="text-text-muted">Product</dt>
                      <dd className="text-text break-words">{loan.productName}</dd>
                    </div>
                  </dl>

                  <p className="text-text-muted mt-2 text-sm">
                    {LOAN_WORKFLOW_LABELS[loan.workflowStage]}
                    {loan.arrearsAmount !== null && loan.arrearsAmount > 0 ? (
                      <>
                        {' · '}
                        <Money amount={toUgx(loan.arrearsAmount)} /> in arrears
                      </>
                    ) : null}
                  </p>
                </RowLink>
              </li>
            ))}
          </ul>

          <div className="hidden min-w-0 md:block">
            <DataTable caption="Loan register, most recently started first">
              <thead>
                <tr>
                  <TableHead width="ref">Loan</TableHead>
                  <TableHead width="name">Client</TableHead>
                  <TableHead width="product">Product</TableHead>
                  <TableHead width="money" align="numeric">
                    Principal
                  </TableHead>
                  <TableHead width="count" hideBelow="2xl">
                    Period
                  </TableHead>
                  <TableHead width="rate" align="numeric" hideBelow="2xl">
                    Rate
                  </TableHead>
                  <TableHead width="money" align="numeric">
                    Repayable
                  </TableHead>
                  <TableHead width="date" hideBelow="2xl">
                    Started
                  </TableHead>
                  <TableHead width="status">Status</TableHead>
                  <TableHead width="status-wide">Stage</TableHead>
                </tr>
              </thead>
              <tbody>
                {page.loans.map((loan) => (
                  <TableRow key={loan.id} interactive>
                    <TableCell width="ref" className="font-mono">
                      <RowLink
                        href={`/loans/${loan.id}`}
                        className="text-accent focus-visible:outline-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
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
                    <TableCell width="product" wrap="wrap" className="text-text-muted">
                      <TableLead
                        primary={loan.productName}
                        secondary={loan.productCode}
                      />
                    </TableCell>
                    <TableCell width="money" align="numeric">
                      <Money amount={toUgx(loan.principalAmount)} />
                    </TableCell>
                    <TableCell width="count" hideBelow="2xl" className="text-text-muted">
                      {String(loan.loanTermMonths)} mo
                    </TableCell>
                    <TableCell
                      width="rate"
                      align="numeric"
                      hideBelow="2xl"
                      className="text-text-muted"
                    >
                      {formatBps(toBps(loan.interestRateBps))}
                    </TableCell>
                    <TableCell width="money" align="numeric">
                      {loan.totalExpectedRepayment === 0 ? (
                        <NotRecorded />
                      ) : (
                        <Money amount={toUgx(loan.totalExpectedRepayment)} />
                      )}
                    </TableCell>
                    <TableCell width="date" hideBelow="2xl" className="text-text-muted">
                      <DateValue value={loan.createdAt} />
                    </TableCell>
                    <TableCell width="status">
                      <LoanStatusBadge status={loan.status} />
                    </TableCell>
                    <TableCell width="status-wide">
                      <Badge
                        tone={
                          loan.workflowStage === 'arrears'
                            ? 'danger'
                            : loan.workflowStage === 'grace_period'
                              ? 'warning'
                              : 'neutral'
                        }
                      >
                        {LOAN_WORKFLOW_LABELS[loan.workflowStage]}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </tbody>
            </DataTable>
          </div>
        </>
      )}

      <RegisterPagination page={page.page} hasMore={page.hasMore} />
    </div>
  );
}
