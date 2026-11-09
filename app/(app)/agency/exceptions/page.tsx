import { TriangleAlert } from 'lucide-react';

import { AgencyReadError } from '@/components/agency/read-failure';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { DataTable, TableCell, TableHead, TableRow } from '@/components/ui/data-table';
import { DateValue } from '@/components/ui/data-value';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyTableRow } from '@/components/ui/states';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { getAgencyExceptions } from '@/lib/data/agency';

export const metadata = { title: 'End-of-day exceptions' };

/**
 * What should be looked at before a day is called finished.
 *
 * Every row comes from `agency_end_of_day_exceptions`, which unions four
 * kinds of outstanding work the database already knows how to find. The
 * screen groups them and says what each one means; it does not decide what
 * counts as an exception, because that definition belongs with the data and
 * would drift if a second copy lived here.
 *
 * There is no "close the day" button, and that is not an omission: closing a
 * day is a Policy 2.0 decision that has not been taken, and a button that
 * only cleared this list would be a button that hid work.
 */

const KIND: Readonly<
  Record<
    string,
    {
      readonly label: string;
      readonly tone: 'info' | 'warning' | 'danger';
      readonly what: string;
    }
  >
> = {
  unverified_transaction: {
    label: 'Not verified',
    tone: 'warning',
    what: 'Recorded at the counter and neither verified nor cancelled. No journal exists for it yet.',
  },
  open_reconciliation: {
    label: 'Awaiting certification',
    tone: 'info',
    what: 'A count or a provider statement a second officer has not certified.',
  },
  unexplained_variance: {
    label: 'Unexplained difference',
    tone: 'warning',
    what: 'Certified with a difference that was never written off, so it is still outstanding in the books.',
  },
  float_exhausted: {
    label: 'Float empty',
    tone: 'danger',
    what: 'An active till with nothing in it. Customer withdrawals against it will be refused.',
  },
};

export default async function AgencyExceptionsPage() {
  await guardPermission(ROUTES.agencyExceptions, 'agency:reports');
  const read = await getAgencyExceptions();

  const header = (
    <PageHeader
      eyebrow="Agency Banking"
      icon={TriangleAlert}
      title="End-of-day exceptions"
      description="Outstanding agency work, by kind, at the branches you can see."
      back={{ href: ROUTES.agency, label: 'Agency Services' }}
    />
  );

  // This screen's whole purpose is to say whether anything is outstanding,
  // so a failed read is the one thing it must never render as "nothing is".
  // A day closed on a green panel produced by a timed-out query is a day
  // closed on nothing at all.
  if (!read.ok) {
    return (
      <div className="min-w-0 space-y-4">
        {header}
        <AgencyReadError failure={read} />
      </div>
    );
  }

  const rows = read.rows;
  const kinds = Object.keys(KIND).filter((kind) => rows.some((r) => r.kind === kind));

  return (
    <div className="min-w-0 space-y-4">
      {header}

      {rows.length === 0 ? (
        <Alert tone="success">
          Nothing outstanding. Every transaction is verified or cancelled, every
          reconciliation is certified with its difference explained, and no active till
          has run dry.
        </Alert>
      ) : (
        <Alert tone="info">
          {rows.length === 1
            ? 'One item is outstanding.'
            : `${String(rows.length)} items are outstanding.`}{' '}
          Each is handled on its own screen: this list is where to find them, not where to
          clear them.
        </Alert>
      )}

      {kinds.map((kind) => {
        const meta = KIND[kind]!;
        const forKind = rows.filter((r) => r.kind === kind);
        return (
          <Card key={kind}>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Badge tone={meta.tone} shape="pill">
                {meta.label}
              </Badge>
              <span className="text-text-muted text-xs">
                {forKind.length === 1 ? '1 item' : `${String(forKind.length)} items`}
              </span>
            </div>
            <p className="text-text-muted mt-1 text-xs">{meta.what}</p>
            <div className="mt-2 min-w-0">
              <DataTable caption={`${meta.label} exceptions`} density="compact">
                <thead>
                  <tr>
                    <TableHead width="date">Date</TableHead>
                    <TableHead width="name">Provider</TableHead>
                    <TableHead align="numeric" width="money">
                      Amount
                    </TableHead>
                    <TableHead width="prose">Detail</TableHead>
                  </tr>
                </thead>
                <tbody>
                  {forKind.length === 0 ? (
                    <EmptyTableRow colSpan={4}>Nothing of this kind.</EmptyTableRow>
                  ) : (
                    forKind.map((row) => (
                      <TableRow key={`${row.kind}|${row.subjectId}`}>
                        <TableCell header>
                          {row.asOfDate === null ? (
                            <span className="text-text-muted">—</span>
                          ) : (
                            <DateValue value={row.asOfDate} />
                          )}
                        </TableCell>
                        <TableCell>{row.providerName ?? '—'}</TableCell>
                        <TableCell align="numeric">
                          <span className="tabular-nums">
                            {row.amount.toLocaleString('en-UG')}
                          </span>
                        </TableCell>
                        <TableCell wrap="wrap">{row.detail}</TableCell>
                      </TableRow>
                    ))
                  )}
                </tbody>
              </DataTable>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
