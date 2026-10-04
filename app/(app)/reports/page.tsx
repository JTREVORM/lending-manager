import Link from 'next/link';

import { Card } from '@/components/ui/card';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import type { Permission } from '@/lib/permissions';

export const metadata = { title: 'Reports' };

interface ReportLink {
  readonly href: string;
  readonly title: string;
  readonly description: string;
  /** Every capability the report needs. All of them, not any of them. */
  readonly needs: readonly Permission[];
}

const REPORTS: readonly ReportLink[] = [
  {
    href: `${ROUTES.reports}/collections`,
    title: 'Collections',
    description:
      'Payments received over a date range, by day, week or month and by method. Reversed payments are listed and excluded from the totals.',
    needs: ['reports:view_operational', 'payments:view'],
  },
  {
    href: `${ROUTES.reports}/arrears`,
    title: 'Arrears',
    description:
      'Every loan that is behind: what is overdue, how late, how many collections were missed, and the latest note on the client.',
    needs: ['reports:view_operational', 'delinquency:view'],
  },
  {
    href: `${ROUTES.reports}/grace`,
    title: 'Grace period',
    description:
      'Loans past their final collection date that can still settle with no charge, and the date each grace period ends.',
    needs: ['reports:view_operational', 'delinquency:view'],
  },
  {
    href: `${ROUTES.reports}/clients`,
    title: 'Clients',
    description:
      'The client directory with each borrower’s outstanding balance and current status. No identification numbers.',
    needs: ['reports:view_operational', 'clients:view'],
  },
  {
    href: `${ROUTES.reports}/loans`,
    title: 'Loan portfolio',
    description:
      'Every loan with its contract, what has been paid, what is outstanding and its current status. Filter by status, state or disbursement date.',
    needs: ['reports:view_financial', 'loans:view'],
  },
  {
    href: `${ROUTES.reports}/penalties`,
    title: 'Late-payment charges',
    description:
      'Every charge raised: what it was charged on, at what rate, what has been paid and what remains.',
    needs: ['reports:view_financial', 'penalties:view'],
  },
];

/**
 * The reporting index.
 *
 * ## Why a report is listed only when every capability is held
 *
 * `needs` is a conjunction, not a disjunction. The arrears report is a
 * rendering of delinquency data, so a holder of `reports:view_operational` who
 * somehow lacked `delinquency:view` would open it and see nothing — Row Level
 * Security would refuse the rows. Listing it would be an invitation to a blank
 * page, and a blank page is how somebody concludes the system is broken rather
 * than that they are not entitled.
 *
 * The listing is a courtesy either way. Each page performs its own
 * `guardPermission`, and the export routes check again, because a URL can be
 * typed and a hidden link protects nothing.
 */
export default async function ReportsPage() {
  const context = await guardPermission(ROUTES.reports, 'reports:view_operational');

  const available = REPORTS.filter((report) =>
    report.needs.every((permission) => contextCan(context, permission)),
  );

  return (
    <div className="min-w-0 space-y-6">
      <header className="min-w-0">
        <h1 className="text-text text-2xl font-semibold">Reports</h1>
        <p className="text-text-muted mt-1 text-sm">
          Every figure here is read from the ledger and the schedules. Nothing on these
          pages changes a record.
        </p>
      </header>

      <ul className="grid min-w-0 gap-3 sm:grid-cols-2">
        {available.map((report) => (
          <li key={report.href} className="min-w-0">
            <Link href={report.href} className="block">
              <Card className="hover:bg-surface-raised h-full transition-colors">
                <h2 className="text-text text-base font-semibold">{report.title}</h2>
                <p className="text-text-muted mt-1 text-sm">{report.description}</p>
              </Card>
            </Link>
          </li>
        ))}
      </ul>

      {available.length === 0 ? (
        <Card>
          <p className="text-text font-medium">No reports are available to you</p>
          <p className="text-text-muted mt-1 text-sm">
            Your role does not include any reporting capability. Speak to the
            Owner/Administrator if you need one.
          </p>
        </Card>
      ) : null}
    </div>
  );
}
