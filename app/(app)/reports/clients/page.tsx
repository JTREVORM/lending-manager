import Link from 'next/link';

import { DelinquencyBadge } from '@/components/delinquency/delinquency-badge';
import { ClientStatusBadge } from '@/components/clients/client-status-badge';
import { ExportLink } from '@/components/reports/export-link';
import { PrintButton } from '@/components/reports/print-button';
import { ReportEmpty } from '@/components/reports/report-empty';
import { ReportFilters } from '@/components/reports/report-filters';
import { ReportPagination } from '@/components/reports/report-pagination';
import { ReportTable, type ReportColumn } from '@/components/reports/report-table';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { getCompanyBranding } from '@/lib/data/company';
import { getClientReport, type ClientReportRow } from '@/lib/data/reports';
import { CLIENT_STATUS_LABELS, isClientStatus } from '@/lib/domain/client';
import { businessToday, formatBusinessDate } from '@/lib/domain/datetime';
import { formatUgx } from '@/lib/domain/money';
import { formatUgandanPhoneLocal } from '@/lib/domain/phone';
import {
  CLIENT_STATUS_OPTIONS,
  exportQuery,
  parseClientStatus,
  singleParam,
  type ParamRecord,
} from '@/lib/reports/filters';

export const metadata = { title: 'Client report' };

const FILTER_KEYS = ['clientStatus', 'query'];

/**
 * The client directory, with each borrower's position beside them.
 *
 * ## No National Identification Number, here or in the export
 *
 * Not behind `clients:view_nin`, not in a column somebody can hide. A NIN is
 * read one record at a time by somebody with a reason to look at that record;
 * a directory listing them is a different object, and its CSV outlives every
 * access control this application has. §76, and the Phase 3 rule it restates.
 *
 * ## Archived and blacklisted clients are still listed
 *
 * With their status shown. A client's status describes whether the business
 * will lend to them again; it says nothing about the loans they already have
 * and the money they already owe. Hiding them would make the outstanding
 * column disagree with the portfolio total, and would lose the financial
 * history of exactly the borrowers most likely to be asked about. §132, §133.
 */
export default async function ClientReportPage({
  searchParams,
}: {
  readonly searchParams: Promise<ParamRecord>;
}) {
  await guardPermission(`${ROUTES.reports}/clients`, 'reports:view_operational');
  await guardPermission(`${ROUTES.reports}/clients`, 'clients:view');

  const params = await searchParams;
  const { branding } = await getCompanyBranding();
  const today = businessToday(new Date(), branding.timezone);

  const report = await getClientReport({
    status: parseClientStatus(params),
    query: singleParam(params, 'query'),
    page: singleParam(params, 'page'),
  });

  const query = exportQuery(params, FILTER_KEYS);

  const columns: readonly ReportColumn<ClientReportRow>[] = [
    {
      key: 'client',
      header: 'Client',
      primary: true,
      cell: (row) => (
        <Link
          href={`${ROUTES.clients}/${row.clientId}`}
          className="text-brand-700 hover:underline"
        >
          {row.fullName}
        </Link>
      ),
    },
    {
      key: 'number',
      header: 'Client number',
      cell: (row) => <span className="font-mono">{row.clientNumber}</span>,
    },
    { key: 'phone', header: 'Phone', cell: (row) => formatUgandanPhoneLocal(row.phone) },
    {
      key: 'location',
      header: 'Location',
      hideOnMobile: true,
      cell: (row) =>
        [row.villageArea, row.district].filter((part) => part !== null).join(', ') || '—',
    },
    {
      key: 'occupation',
      header: 'Occupation',
      hideOnMobile: true,
      cell: (row) => row.occupation ?? '—',
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) =>
        isClientStatus(row.status) ? (
          <ClientStatusBadge status={row.status} />
        ) : (
          row.status
        ),
    },
    {
      key: 'borrowing',
      header: 'Borrowing',
      cell: (row) => (row.hasActiveLoan ? 'Yes' : 'No'),
    },
    {
      key: 'outstanding',
      header: 'Outstanding',
      numeric: true,
      cell: (row) => formatUgx(row.totalOutstanding, { withCurrency: false }),
    },
    {
      key: 'arrears',
      header: 'Arrears',
      numeric: true,
      cell: (row) =>
        row.arrearsAmount === 0
          ? '—'
          : formatUgx(row.arrearsAmount, { withCurrency: false }),
    },
    {
      key: 'delinquency',
      header: 'Loan status',
      cell: (row) => (row.state === null ? '—' : <DelinquencyBadge state={row.state} />),
    },
  ];

  return (
    <div className="min-w-0 space-y-5">
      <header className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-text text-2xl font-semibold">Clients</h1>
            <p className="text-text-muted mt-1 text-sm">
              As at {formatBusinessDate(today)} · {branding.companyName}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <PrintButton />
            <ExportLink
              href={`${ROUTES.reports}/clients/export${query === '' ? '' : `?${query}`}`}
            />
          </div>
        </div>
        <p className="text-text-muted text-sm">
          Outstanding is the total across every loan the client has. Identification
          numbers are never shown in a report or an export.
        </p>
      </header>

      <ReportFilters
        filters={[
          {
            kind: 'select',
            name: 'clientStatus',
            label: 'Client status',
            options: CLIENT_STATUS_OPTIONS.map((status) => ({
              value: status,
              label: CLIENT_STATUS_LABELS[status],
            })),
          },
          {
            kind: 'search',
            name: 'query',
            label: 'Search',
            placeholder: 'Name, number or phone',
          },
        ]}
        resultSummary={`${String(report.matchedRows)} ${report.matchedRows === 1 ? 'client' : 'clients'}`}
      />

      {report.page.rows.length === 0 ? (
        <ReportEmpty
          title="No clients match"
          description="Try clearing the status filter or searching for a different name."
        />
      ) : (
        <ReportTable
          columns={columns}
          rows={report.page.rows}
          rowKey={(row) => row.clientId}
          caption="Clients with their contact details, status and what they owe"
        />
      )}

      <ReportPagination
        page={report.page.page}
        hasMore={report.page.hasMore}
        rowsShown={report.page.rows.length}
      />
    </div>
  );
}
