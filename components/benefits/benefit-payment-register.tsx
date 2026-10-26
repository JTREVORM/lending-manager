'use client';

import { Receipt, SearchX } from 'lucide-react';

import {
  DataTable,
  TableCell,
  TableHead,
  TableLead,
  TableRow,
} from '@/components/ui/data-table';
import { DateValue } from '@/components/ui/data-value';
import { Money } from '@/components/ui/money';
import {
  RegisterCount,
  RegisterFilters,
  RegisterPagination,
} from '@/components/ui/register';
import { RowLink } from '@/components/ui/row-link';
import { EmptyState } from '@/components/ui/states';
import { ROUTES } from '@/config/app';
import type { BenefitPaymentPage } from '@/lib/data/benefits';
import { BENEFIT_CLAIM_TYPES, BENEFIT_CLAIM_TYPE_LABELS } from '@/lib/domain/benefits';
import { PAYMENT_METHOD_LABELS } from '@/lib/domain/payment';
import { BenefitClaimTypeBadge } from './benefit-badges';

/**
 * Benefit payments, newest value date first.
 *
 * ## It is a reconciliation screen, so it shows the accounts
 *
 * Every row names the expense account it was posted to and the cash account it
 * came out of, because the question this register answers is "does the benefits
 * expense in the trial balance correspond to payments we can point at". A
 * register that showed only amounts would make that a manual exercise against
 * the ledger.
 *
 * ## A reversed payment stays in the register
 *
 * Struck through and labelled, never removed. The contra entry is on the
 * ledger and the original stands, so a register that hid the reversed row
 * would disagree with the journal — and "where did this expense go" is
 * exactly the question somebody asks six months later.
 *
 * ## What a reader without `membership:view_sensitive` sees
 *
 * Fewer rows. The policy on `benefit_payments` withholds payments whose payee
 * is a beneficiary, because the row carries their name — so a
 * Secretary/Treasurer reconciles medical and condolence benefits, and a
 * bereavement payment is a row they are not entitled to read rather than a
 * name they should not have seen. The count line therefore reports what they
 * can see, which is the honest figure for them.
 */
export function BenefitPaymentRegister({
  page,
  filter,
}: {
  readonly page: BenefitPaymentPage;
  readonly filter: {
    readonly type: string;
    readonly from: string;
    readonly to: string;
  };
}) {
  const filtered = filter.type !== '' || filter.from !== '' || filter.to !== '';

  return (
    <div className="min-w-0 space-y-4">
      <RegisterFilters
        selects={[
          {
            id: 'benefit-payment-type',
            label: 'Benefit',
            param: 'type',
            value: filter.type,
            options: [
              { value: '', label: 'All benefits' },
              ...BENEFIT_CLAIM_TYPES.map((type) => ({
                value: type,
                label: BENEFIT_CLAIM_TYPE_LABELS[type],
              })),
            ],
          },
        ]}
        summary={
          <RegisterCount
            shown={page.payments.length}
            page={page.page}
            hasMore={page.hasMore}
            noun="payment"
          />
        }
      />

      {page.payments.length === 0 ? (
        <EmptyState
          icon={filtered ? SearchX : Receipt}
          title={filtered ? 'No payment in that range' : 'No benefit has been paid yet'}
          description={
            filtered
              ? 'Try clearing the benefit filter, or a wider range of dates.'
              : 'A payment appears here once an approved claim has been paid. Every row carries the journal entry behind it.'
          }
        />
      ) : (
        <>
          {/* Phone: cards. */}
          <ul className="space-y-3 md:hidden">
            {page.payments.map((payment) => (
              <li key={payment.id}>
                <RowLink
                  href={`${ROUTES.benefitClaims}/${payment.claimId}`}
                  className="record-surface focus-visible:outline-accent block rounded-lg p-4 focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-text font-medium break-words">
                        {payment.memberName}
                      </p>
                      <p className="text-text-muted font-mono text-sm">
                        {payment.paymentNumber} · {payment.claimNumber}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p
                        className={
                          payment.isLive
                            ? 'text-text font-semibold tabular-nums'
                            : 'text-text-muted tabular-nums line-through'
                        }
                      >
                        <Money amount={payment.amount} />
                      </p>
                      {payment.isLive ? null : (
                        <p className="text-danger text-xs font-medium">Reversed</p>
                      )}
                    </div>
                  </div>

                  <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                    <div className="min-w-0">
                      <dt className="text-text-muted">Benefit</dt>
                      <dd className="text-text">
                        {BENEFIT_CLAIM_TYPE_LABELS[payment.claimType]}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-text-muted">Value date</dt>
                      <dd className="text-text">
                        <DateValue value={payment.valueDate} />
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-text-muted">Paid to</dt>
                      <dd className="text-text break-words">{payment.recipientName}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-text-muted">Posted to</dt>
                      <dd className="text-text font-mono">
                        {payment.expenseAccountCode}
                      </dd>
                    </div>
                  </dl>
                </RowLink>
              </li>
            ))}
          </ul>

          {/* Tablet and up: a table. */}
          <div className="hidden min-w-0 md:block">
            <DataTable caption="Benefit payments, newest value date first">
              <thead>
                <tr>
                  <TableHead width="ref">Payment</TableHead>
                  <TableHead width="name-wide">Member</TableHead>
                  <TableHead width="status">Benefit</TableHead>
                  <TableHead width="name">Paid to</TableHead>
                  <TableHead width="money" align="numeric">
                    Amount
                  </TableHead>
                  <TableHead width="date">Value date</TableHead>
                  <TableHead width="status" hideBelow="lg">
                    Method
                  </TableHead>
                  <TableHead width="ref" hideBelow="xl">
                    Posted to
                  </TableHead>
                </tr>
              </thead>
              <tbody>
                {page.payments.map((payment) => (
                  <TableRow key={payment.id} interactive>
                    <TableCell width="ref" className="font-mono">
                      <RowLink
                        href={`${ROUTES.benefitClaims}/${payment.claimId}`}
                        className="text-accent focus-visible:outline-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                      >
                        {payment.paymentNumber}
                      </RowLink>
                      {payment.isLive ? null : (
                        <span className="text-danger block text-[11px] font-medium">
                          Reversed
                        </span>
                      )}
                    </TableCell>
                    <TableCell width="name-wide" wrap="wrap">
                      <TableLead
                        primary={payment.memberName}
                        secondary={payment.claimNumber}
                      />
                    </TableCell>
                    <TableCell width="status">
                      <BenefitClaimTypeBadge type={payment.claimType} />
                    </TableCell>
                    <TableCell width="name" wrap="clamp">
                      {payment.recipientName}
                    </TableCell>
                    <TableCell width="money" align="numeric">
                      <span className={payment.isLive ? undefined : 'line-through'}>
                        <Money
                          amount={payment.amount}
                          weight={payment.isLive ? 'semibold' : 'normal'}
                        />
                      </span>
                    </TableCell>
                    <TableCell width="date">
                      <DateValue value={payment.valueDate} />
                    </TableCell>
                    <TableCell width="status" hideBelow="lg">
                      {PAYMENT_METHOD_LABELS[payment.paymentMethod]}
                      {payment.externalReference === null ? null : (
                        <span className="text-text-muted block font-mono text-[11px]">
                          {payment.externalReference}
                        </span>
                      )}
                    </TableCell>
                    <TableCell width="ref" hideBelow="xl" className="font-mono">
                      {payment.expenseAccountCode}
                      <span className="text-text-muted block text-[11px]">
                        from {payment.cashAccountCode}
                      </span>
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
