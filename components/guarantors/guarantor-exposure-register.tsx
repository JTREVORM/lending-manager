'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  DataTable,
  NotRecorded,
  TableCell,
  TableHead,
  TableRow,
} from '@/components/ui/data-table';
import { Money } from '@/components/ui/money';
import { RowLink } from '@/components/ui/row-link';
import { DateValue, PhoneValue } from '@/components/ui/data-value';
import { ROUTES } from '@/config/app';
import { GUARANTOR_SUBJECT_LABELS } from '@/lib/domain/guarantor';
import {
  GUARANTEE_STATUSES,
  GUARANTEE_STATUS_DESCRIPTIONS,
  GUARANTEE_STATUS_LABELS,
  type GuaranteeStatus,
} from '@/lib/domain/security';
import type { GuarantorExposureRow } from '@/lib/data/security';

/**
 * The guarantor register: who stands for whom, for how much, and whether it
 * still binds.
 *
 * ## Exposure is the loan's, not a share of it
 *
 * A guarantee here is joint over the whole loan. Two guarantors on one loan
 * each show the full outstanding figure, so the column does not sum to the
 * portfolio — and the note under the table says so, because a reader who adds
 * it up and compares the result with the loan book will otherwise conclude the
 * register is wrong.
 *
 * ## Status is derived, not stored
 *
 * Most guarantees end by themselves: the loan clears, or it is cancelled.
 * Those read as "discharged" and "void" from the loan's own status, with no
 * column to go stale. Only a discretionary release — a Manager letting
 * somebody out while the loan is live — is a stored decision, and that one
 * carries its reason.
 */
export function GuarantorExposureRegister({
  rows,
  page,
  hasMore,
  products,
}: {
  readonly rows: readonly GuarantorExposureRow[];
  readonly page: number;
  readonly hasMore: boolean;
  readonly products: readonly { readonly id: string; readonly label: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const [query, setQuery] = useState(params.get('query') ?? '');

  const apply = (updates: Readonly<Record<string, string | null>>): void => {
    const next = new URLSearchParams(params.toString());

    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }

    next.delete('page');

    startTransition(() => {
      router.replace(`${pathname}?${next.toString()}`);
    });
  };

  const pageParams = (target: number): string => {
    const next = new URLSearchParams(params.toString());
    next.set('page', String(target));
    return next.toString();
  };

  const liveExposure = rows
    .filter(
      (row) => row.guaranteeStatus === 'binding' || row.guaranteeStatus === 'unsigned',
    )
    .reduce((sum, row) => sum + (row.outstandingBalance ?? 0), 0);

  return (
    <div className="min-w-0 space-y-4" aria-busy={isPending}>
      <Card className="min-w-0">
        <form
          className="min-w-0 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            apply({ query });
          }}
        >
          <div className="flex min-w-0 flex-wrap gap-2">
            <div className="min-w-0 grow">
              <label htmlFor="guarantee-search" className="sr-only">
                Search by guarantor, phone, borrower or loan number
              </label>
              <Input
                id="guarantee-search"
                type="search"
                placeholder="Guarantor, phone, borrower or loan number"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                }}
              />
            </div>
            <Button type="submit">Search</Button>
          </div>

          <div className="flex min-w-0 flex-wrap gap-3">
            <div className="min-w-0">
              <label htmlFor="guarantee-kind" className="text-text-muted block text-sm">
                Guarantor type
              </label>
              <select
                id="guarantee-kind"
                className="border-border bg-surface text-text focus-visible:outline-accent min-h-11 rounded-lg border px-3 focus-visible:outline-2 focus-visible:outline-offset-2"
                value={params.get('subjectKind') ?? ''}
                onChange={(event) => {
                  apply({ subjectKind: event.target.value });
                }}
              >
                <option value="">Everyone</option>
                <option value="client">{GUARANTOR_SUBJECT_LABELS.client}</option>
                <option value="external">{GUARANTOR_SUBJECT_LABELS.external}</option>
              </select>
            </div>

            <div className="min-w-0">
              <label htmlFor="guarantee-status" className="text-text-muted block text-sm">
                Guarantee status
              </label>
              <select
                id="guarantee-status"
                className="border-border bg-surface text-text focus-visible:outline-accent min-h-11 rounded-lg border px-3 focus-visible:outline-2 focus-visible:outline-offset-2"
                value={params.get('guaranteeStatus') ?? ''}
                onChange={(event) => {
                  apply({ guaranteeStatus: event.target.value });
                }}
              >
                <option value="">Any status</option>
                {GUARANTEE_STATUSES.map((status: GuaranteeStatus) => (
                  <option key={status} value={status}>
                    {GUARANTEE_STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            </div>

            <div className="min-w-0">
              <label
                htmlFor="guarantee-product"
                className="text-text-muted block text-sm"
              >
                Loan product
              </label>
              <select
                id="guarantee-product"
                className="border-border bg-surface text-text focus-visible:outline-accent min-h-11 rounded-lg border px-3 focus-visible:outline-2 focus-visible:outline-offset-2"
                value={params.get('productId') ?? ''}
                onChange={(event) => {
                  apply({ productId: event.target.value });
                }}
              >
                <option value="">Every product</option>
                {products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </form>
      </Card>

      {rows.length === 0 ? (
        <Card>
          <p className="text-text-muted text-sm">
            No guarantee matches. That is not the same as nobody guaranteeing anything —
            try clearing the filters.
          </p>
        </Card>
      ) : (
        <>
          {/* Phones: one card per guarantee. */}
          <ul className="min-w-0 space-y-2 lg:hidden">
            {rows.map((row) => (
              <li key={row.loanGuarantorId} className="min-w-0">
                <div className="record-surface focus-within:outline-accent relative min-w-0 rounded-lg p-3 focus-within:outline-2 focus-within:outline-offset-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <RowLink
                      href={`${ROUTES.loans}/${row.loanId}`}
                      className="text-text font-medium break-words before:absolute before:inset-0 before:content-['']"
                    >
                      {row.guarantorName}
                    </RowLink>
                    <Badge
                      tone={row.guaranteeStatus === 'binding' ? 'info' : 'neutral'}
                      title={GUARANTEE_STATUS_DESCRIPTIONS[row.guaranteeStatus]}
                    >
                      {GUARANTEE_STATUS_LABELS[row.guaranteeStatus]}
                    </Badge>
                  </div>

                  <div className="text-text-muted mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    <span>{GUARANTOR_SUBJECT_LABELS[row.subjectKind]}</span>
                    <PhoneValue
                      value={row.guarantorPhone}
                      linked
                      className="text-accent relative"
                    />
                  </div>

                  <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                    <div>
                      <dt className="text-text-muted">Borrower</dt>
                      <dd className="text-text break-words">{row.clientName}</dd>
                    </div>
                    <div>
                      <dt className="text-text-muted">Loan</dt>
                      <dd className="text-text font-mono">{row.loanNumber}</dd>
                    </div>
                    <div>
                      <dt className="text-text-muted">Guaranteed</dt>
                      <dd className="text-text tabular-nums">
                        <Money amount={row.guaranteedAmount} />
                      </dd>
                    </div>
                    <div>
                      <dt className="text-text-muted">Outstanding</dt>
                      <dd className="text-text tabular-nums">
                        {row.outstandingBalance === null ? (
                          '—'
                        ) : (
                          <Money amount={row.outstandingBalance} />
                        )}
                      </dd>
                    </div>
                  </dl>
                </div>
              </li>
            ))}
          </ul>

          {/* Large screens: the twelve columns the register is asked for.
              They do not fit any screen made, so the table scrolls inside its
              own box; the three a reviewer can work without at 1024px — the
              product code, the loan's status and the release note, all of
              them on the loan's own page — step out below `xl`. */}
          <div className="hidden min-w-0 lg:block">
            <DataTable caption="Guarantor register" density="compact">
              <thead>
                <tr>
                  <TableHead width="name">Guarantor</TableHead>
                  <TableHead width="count">Type</TableHead>
                  <TableHead width="phone">Phone</TableHead>
                  <TableHead width="name">Borrower</TableHead>
                  <TableHead width="ref">Loan</TableHead>
                  <TableHead width="count" hideBelow="xl">
                    Product
                  </TableHead>
                  <TableHead width="money" align="numeric">
                    Guaranteed
                  </TableHead>
                  <TableHead width="money" align="numeric">
                    Outstanding
                  </TableHead>
                  <TableHead width="date">Signed</TableHead>
                  <TableHead width="status" hideBelow="xl">
                    Loan status
                  </TableHead>
                  <TableHead width="status">Guarantee</TableHead>
                  <TableHead width="prose" hideBelow="xl">
                    Released
                  </TableHead>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <TableRow key={row.loanGuarantorId}>
                    <TableCell header width="name" wrap="wrap">
                      <span className="block min-w-0">
                        {row.guarantorClientId === null ? (
                          <span
                            className="text-text line-clamp-2 break-words"
                            title={row.guarantorName}
                          >
                            {row.guarantorName}
                          </span>
                        ) : (
                          <RowLink
                            href={`${ROUTES.clients}/${row.guarantorClientId}`}
                            className="text-brand-700 line-clamp-2 break-words hover:underline"
                            title={row.guarantorName}
                          >
                            {row.guarantorName}
                          </RowLink>
                        )}
                        <span className="text-text-muted mt-0.5 block text-[10px] font-normal">
                          {row.relationshipToClient}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell width="count" className="text-text">
                      {GUARANTOR_SUBJECT_LABELS[row.subjectKind]}
                    </TableCell>
                    <TableCell width="phone">
                      <PhoneValue
                        value={row.guarantorPhone}
                        linked
                        className="text-accent"
                      />
                    </TableCell>
                    <TableCell width="name" wrap="wrap">
                      <span className="block min-w-0">
                        <RowLink
                          href={`${ROUTES.clients}/${row.clientId}`}
                          className="text-brand-700 line-clamp-2 break-words hover:underline"
                          title={row.clientName}
                        >
                          {row.clientName}
                        </RowLink>
                        <span className="text-text-muted mt-0.5 block font-mono text-[10px] whitespace-nowrap">
                          {row.clientNumber}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell width="ref">
                      <RowLink
                        href={`${ROUTES.loans}/${row.loanId}`}
                        className="text-brand-700 font-mono hover:underline"
                      >
                        {row.loanNumber}
                      </RowLink>
                    </TableCell>
                    <TableCell width="count" hideBelow="xl" className="text-text">
                      {row.productCode}
                    </TableCell>
                    <TableCell width="money" align="numeric" className="text-text">
                      <Money amount={row.guaranteedAmount} />
                    </TableCell>
                    <TableCell width="money" align="numeric" className="text-text">
                      {row.outstandingBalance === null ? (
                        <NotRecorded />
                      ) : (
                        <Money amount={row.outstandingBalance} />
                      )}
                    </TableCell>
                    <TableCell width="date" className="text-text">
                      {row.guaranteeDate === null ? (
                        'Not signed'
                      ) : (
                        <DateValue value={row.guaranteeDate} />
                      )}
                    </TableCell>
                    <TableCell width="status" hideBelow="xl" className="text-text">
                      {row.loanStatus}
                    </TableCell>
                    <TableCell width="status">
                      <Badge
                        tone={row.guaranteeStatus === 'binding' ? 'info' : 'neutral'}
                        title={GUARANTEE_STATUS_DESCRIPTIONS[row.guaranteeStatus]}
                      >
                        {GUARANTEE_STATUS_LABELS[row.guaranteeStatus]}
                      </Badge>
                    </TableCell>
                    <TableCell
                      width="prose"
                      wrap="wrap"
                      hideBelow="xl"
                      className="text-text-muted"
                    >
                      {row.releasedAt === null ? (
                        <NotRecorded />
                      ) : (
                        <>
                          <DateValue value={row.releasedAt} />
                          <span className="block text-[10px] break-words">
                            {row.releaseReason}
                          </span>
                        </>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </tbody>
            </DataTable>
          </div>

          <Card className="min-w-0">
            <p className="text-text-muted text-sm">
              Live exposure on this page: <Money amount={liveExposure} />. A guarantee is
              joint over the whole loan, so two guarantors on one loan each show its full
              outstanding balance — the column is not a division of the debt and does not
              sum to the loan book.
            </p>
          </Card>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-text-muted text-sm">Page {page}</p>
            <div className="flex gap-2">
              {page > 1 ? (
                <RowLink
                  href={`${pathname}?${pageParams(page - 1)}`}
                  className="text-brand-700 min-h-11 text-sm font-medium hover:underline"
                >
                  Previous
                </RowLink>
              ) : null}
              {hasMore ? (
                <RowLink
                  href={`${pathname}?${pageParams(page + 1)}`}
                  className="text-brand-700 min-h-11 text-sm font-medium hover:underline"
                >
                  Next
                </RowLink>
              ) : null}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
