import { PackageOpen } from 'lucide-react';
import Link from 'next/link';

import { Card } from '@/components/ui/card';
import {
  DataTable,
  TableCell,
  TableFootRow,
  TableHead,
  TableRow,
} from '@/components/ui/data-table';
import { Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { getPortfolioByProduct } from '@/lib/data/loan-application';
import { toUgx } from '@/lib/domain/money';

export const metadata = { title: 'Loans by product' };

/**
 * The portfolio, grouped by the product each loan was written under.
 *
 * One of the eleven views the loan module presents, and the one that needs a
 * different shape: the others are lists of loans, this is a list of products
 * with a loan count against each. Every row links back into the register
 * filtered to that product, so "nine arrears on Salary Loans" is one click
 * from the nine loans.
 *
 * The figures come from the same register the other views read. Outstanding
 * counts active loans only — an approved loan owes nothing yet and a cleared
 * one no longer does, and adding either would make this table disagree with
 * the dashboard it will feed in Phase 8.
 */
export default async function LoansByProductPage() {
  await guardPermission(`${ROUTES.loans}/by-product`, 'loans:view');

  const rows = await getPortfolioByProduct();

  const totals = rows.reduce(
    (sum, row) => ({
      loanCount: sum.loanCount + row.loanCount,
      activeCount: sum.activeCount + row.activeCount,
      arrearsCount: sum.arrearsCount + row.arrearsCount,
      clearedCount: sum.clearedCount + row.clearedCount,
      principalDisbursed: sum.principalDisbursed + row.principalDisbursed,
      outstanding: sum.outstanding + row.outstanding,
    }),
    {
      loanCount: 0,
      activeCount: 0,
      arrearsCount: 0,
      clearedCount: 0,
      principalDisbursed: 0,
      outstanding: 0,
    },
  );

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Lending Portfolio"
        icon={PackageOpen}
        back={{ href: ROUTES.loans, label: 'Loans' }}
        title="Loans by product"
        description="What the business has written under each product, and what is still owed on it."
      />

      {rows.length === 0 ? (
        <Card>
          <p className="text-text-muted">No loans have been recorded yet.</p>
        </Card>
      ) : (
        <>
          {/* Cards on a phone, a table from md up — the same shape the loan
              register uses, so the two screens read as one module. */}
          <ul className="space-y-3 md:hidden">
            {rows.map((row) => (
              <li key={row.productId}>
                <Link
                  href={`${ROUTES.loans}?productId=${row.productId}`}
                  className="record-surface focus-visible:outline-accent block rounded-lg p-4 focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  <p className="text-text font-medium break-words">{row.productName}</p>
                  <p className="text-text-muted font-mono text-sm">{row.productCode}</p>

                  <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                    <div className="min-w-0">
                      <dt className="text-text-muted">Loans</dt>
                      <dd className="text-text tabular-nums">{String(row.loanCount)}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-text-muted">Active</dt>
                      <dd className="text-text tabular-nums">
                        {String(row.activeCount)}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-text-muted">In arrears</dt>
                      <dd className="text-text tabular-nums">
                        {String(row.arrearsCount)}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-text-muted">Outstanding</dt>
                      <dd className="text-text tabular-nums">
                        <Money amount={toUgx(row.outstanding)} />
                      </dd>
                    </div>
                  </dl>
                </Link>
              </li>
            ))}
          </ul>

          <div className="hidden min-w-0 md:block">
            <DataTable caption="The portfolio by loan product">
              <thead>
                <tr>
                  <TableHead width="product">Product</TableHead>
                  <TableHead width="count" align="numeric">
                    Loans
                  </TableHead>
                  <TableHead width="count" align="numeric">
                    Active
                  </TableHead>
                  <TableHead width="count" align="numeric">
                    In arrears
                  </TableHead>
                  <TableHead width="count" align="numeric">
                    Cleared
                  </TableHead>
                  <TableHead width="money" align="numeric">
                    Principal disbursed
                  </TableHead>
                  <TableHead width="money" align="numeric">
                    Outstanding
                  </TableHead>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <TableRow key={row.productId} interactive>
                    <TableCell width="product" wrap="clamp">
                      <span className="block min-w-0">
                        <Link
                          href={`${ROUTES.loans}?productId=${row.productId}`}
                          className="text-accent focus-visible:outline-accent line-clamp-2 break-words underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                          title={row.productName}
                        >
                          {row.productName}
                        </Link>
                        <span className="text-text-muted mt-0.5 block font-mono text-[11px] whitespace-nowrap">
                          {row.productCode}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell width="count" align="numeric">
                      {String(row.loanCount)}
                    </TableCell>
                    <TableCell width="count" align="numeric">
                      {String(row.activeCount)}
                    </TableCell>
                    <TableCell width="count" align="numeric">
                      {String(row.arrearsCount)}
                    </TableCell>
                    <TableCell width="count" align="numeric">
                      {String(row.clearedCount)}
                    </TableCell>
                    <TableCell width="money" align="numeric">
                      <Money amount={toUgx(row.principalDisbursed)} />
                    </TableCell>
                    <TableCell width="money" align="numeric" className="font-medium">
                      <Money amount={toUgx(row.outstanding)} />
                    </TableCell>
                  </TableRow>
                ))}
              </tbody>
              <tfoot>
                <TableFootRow>
                  <TableCell header width="product">
                    All products
                  </TableCell>
                  <TableCell width="count" align="numeric">
                    {String(totals.loanCount)}
                  </TableCell>
                  <TableCell width="count" align="numeric">
                    {String(totals.activeCount)}
                  </TableCell>
                  <TableCell width="count" align="numeric">
                    {String(totals.arrearsCount)}
                  </TableCell>
                  <TableCell width="count" align="numeric">
                    {String(totals.clearedCount)}
                  </TableCell>
                  <TableCell width="money" align="numeric">
                    <Money amount={toUgx(totals.principalDisbursed)} />
                  </TableCell>
                  <TableCell width="money" align="numeric">
                    <Money amount={toUgx(totals.outstanding)} />
                  </TableCell>
                </TableFootRow>
              </tfoot>
            </DataTable>
          </div>
        </>
      )}
    </div>
  );
}
