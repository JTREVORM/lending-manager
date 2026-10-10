import { PackageOpen } from 'lucide-react';
import Link from 'next/link';

import { Card } from '@/components/ui/card';
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
      principalDisbursed: sum.principalDisbursed + row.principalDisbursed,
      outstanding: sum.outstanding + row.outstanding,
    }),
    {
      loanCount: 0,
      activeCount: 0,
      arrearsCount: 0,
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

          <Card className="hidden min-w-0 overflow-x-auto md:block">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">The portfolio by loan product</caption>
              <thead>
                <tr className="border-border bg-surface-sunken border-b">
                  <th scope="col" className="t-th py-2.5 pr-4 whitespace-nowrap">
                    Product
                  </th>
                  <th
                    scope="col"
                    className="t-th py-2.5 pr-4 text-right whitespace-nowrap"
                  >
                    Loans
                  </th>
                  <th
                    scope="col"
                    className="t-th py-2.5 pr-4 text-right whitespace-nowrap"
                  >
                    Active
                  </th>
                  <th
                    scope="col"
                    className="t-th py-2.5 pr-4 text-right whitespace-nowrap"
                  >
                    In arrears
                  </th>
                  <th
                    scope="col"
                    className="t-th py-2.5 pr-4 text-right whitespace-nowrap"
                  >
                    Cleared
                  </th>
                  <th
                    scope="col"
                    className="t-th py-2.5 pr-4 text-right whitespace-nowrap"
                  >
                    Principal disbursed
                  </th>
                  <th scope="col" className="t-th py-2.5 text-right whitespace-nowrap">
                    Outstanding
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.productId}
                    className="border-border border-b last:border-0"
                  >
                    <td className="py-3 pr-4">
                      <Link
                        href={`${ROUTES.loans}?productId=${row.productId}`}
                        className="text-accent focus-visible:outline-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                      >
                        {row.productName}
                      </Link>
                      <span className="text-text-muted block font-mono text-xs">
                        {row.productCode}
                      </span>
                    </td>
                    <td className="text-text py-3 pr-4 text-right tabular-nums">
                      {String(row.loanCount)}
                    </td>
                    <td className="text-text py-3 pr-4 text-right tabular-nums">
                      {String(row.activeCount)}
                    </td>
                    <td className="text-text py-3 pr-4 text-right tabular-nums">
                      {String(row.arrearsCount)}
                    </td>
                    <td className="text-text py-3 pr-4 text-right tabular-nums">
                      {String(row.clearedCount)}
                    </td>
                    <td className="text-text py-3 pr-4 text-right tabular-nums">
                      <Money amount={toUgx(row.principalDisbursed)} />
                    </td>
                    <td className="text-text py-3 text-right font-medium tabular-nums">
                      <Money amount={toUgx(row.outstanding)} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-border border-t-2">
                  <th scope="row" className="text-text py-3 pr-4 text-left font-medium">
                    All products
                  </th>
                  <td className="text-text py-3 pr-4 text-right font-medium tabular-nums">
                    {String(totals.loanCount)}
                  </td>
                  <td className="text-text py-3 pr-4 text-right font-medium tabular-nums">
                    {String(totals.activeCount)}
                  </td>
                  <td className="text-text py-3 pr-4 text-right font-medium tabular-nums">
                    {String(totals.arrearsCount)}
                  </td>
                  <td className="py-3 pr-4" />
                  <td className="text-text py-3 pr-4 text-right font-medium tabular-nums">
                    <Money amount={toUgx(totals.principalDisbursed)} />
                  </td>
                  <td className="text-text py-3 text-right font-medium tabular-nums">
                    <Money amount={toUgx(totals.outstanding)} />
                  </td>
                </tr>
              </tfoot>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}
