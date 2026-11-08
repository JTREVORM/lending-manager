'use client';

import { useActionState } from 'react';

import { AgencySettlementBadge } from '@/components/agency/badges';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { DataTable, TableCell, TableHead, TableRow } from '@/components/ui/data-table';
import { DateValue } from '@/components/ui/data-value';
import { Field } from '@/components/ui/field';
import { Money } from '@/components/ui/money';
import { EmptyTableRow } from '@/components/ui/states';
import {
  reverseCommissionSettlementAction,
  reversePayableSettlementAction,
  type AgencyActionResult,
} from '@/lib/agency/actions';
import type {
  AgencyCommissionSettlementRow,
  AgencyPayableSettlementRow,
} from '@/lib/domain/agency';

type Action = (
  previous: AgencyActionResult | undefined,
  formData: FormData,
) => Promise<AgencyActionResult>;

/**
 * Undoing a settlement that was recorded in error.
 *
 * A reversal is a contra journal, not a deletion: the original entry and this
 * one both stay, and the outstanding figure returns to what it was. The
 * reason is required because it is the only record of why two entries exist
 * where one transaction happened, and the database refuses the reversal
 * without it.
 */
function ReverseControl({
  action,
  settlementId,
  hint,
}: {
  readonly action: Action;
  readonly settlementId: string;
  readonly hint: string;
}) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(action, undefined);

  return (
    <form
      action={submit}
      className="border-border bg-surface-sunken min-w-0 space-y-2 rounded-lg border p-2"
    >
      <input type="hidden" name="settlementId" value={settlementId} />
      <Field
        label="Reason"
        name="reason"
        required
        autoComplete="off"
        hint={hint}
        error={result?.fieldErrors?.reason?.[0]}
      />
      <Button type="submit" size="sm" variant="danger" loading={pending}>
        Reverse
      </Button>
      {result === undefined ? null : (
        <Alert tone={result.ok ? 'success' : 'danger'}>{result.message}</Alert>
      )}
    </form>
  );
}

/** A reversal the viewer may not perform, saying so rather than vanishing. */
function NotYours() {
  return (
    <p className="text-text-muted text-xs" role="note">
      Reversing a settlement is a manager&rsquo;s. Ask one, with the statement in hand.
    </p>
  );
}

export function CommissionSettlementRegister({
  rows,
  canReverse,
}: {
  readonly rows: readonly AgencyCommissionSettlementRow[];
  readonly canReverse: boolean;
}) {
  return (
    <DataTable caption="Commission remittances received from providers" stickyHeader>
      <thead>
        <tr>
          <TableHead width="date">Date</TableHead>
          <TableHead width="name">Provider</TableHead>
          <TableHead align="numeric" width="money">
            Amount
          </TableHead>
          <TableHead width="name">Received into</TableHead>
          <TableHead width="ref">Statement</TableHead>
          <TableHead width="status">Status</TableHead>
          <TableHead width="prose">Correction</TableHead>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <EmptyTableRow colSpan={7}>
            No commission remittance has been recorded at a branch you can see.
          </EmptyTableRow>
        ) : (
          rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell header>
                <DateValue value={row.settlementDate} />
              </TableCell>
              <TableCell>
                {row.providerName}
                <span className="text-text-muted mt-0.5 block text-[10px]">
                  {row.providerCode} · {row.branchCode}
                </span>
              </TableCell>
              <TableCell align="numeric">
                <Money amount={row.settlementAmount} />
              </TableCell>
              <TableCell>
                {row.settlementAccountName}
                <span className="text-text-muted mt-0.5 block text-[10px]">
                  {row.settlementAccountCode}
                </span>
              </TableCell>
              <TableCell>
                <span className="font-mono text-xs">
                  {row.providerStatementRef ?? '—'}
                </span>
              </TableCell>
              <TableCell>
                <AgencySettlementBadge status={row.status} />
              </TableCell>
              <TableCell>
                {row.status === 'reversed' ? (
                  <span className="text-text-muted text-xs">
                    {row.reversalReason ?? 'Reversed.'}
                  </span>
                ) : canReverse ? (
                  <ReverseControl
                    action={reverseCommissionSettlementAction}
                    settlementId={row.id}
                    hint="Why this remittance was not received as recorded. The receivable returns."
                  />
                ) : (
                  <NotYours />
                )}
              </TableCell>
            </TableRow>
          ))
        )}
      </tbody>
    </DataTable>
  );
}

export function PayableSettlementRegister({
  rows,
  canReverse,
}: {
  readonly rows: readonly AgencyPayableSettlementRow[];
  readonly canReverse: boolean;
}) {
  return (
    <DataTable caption="Remittances paid to providers" stickyHeader>
      <thead>
        <tr>
          <TableHead width="date">Date</TableHead>
          <TableHead width="name">Provider</TableHead>
          <TableHead align="numeric" width="money">
            Amount
          </TableHead>
          <TableHead width="name">Paid from</TableHead>
          <TableHead width="ref">Receipt</TableHead>
          <TableHead width="status">Status</TableHead>
          <TableHead width="prose">Correction</TableHead>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <EmptyTableRow colSpan={7}>
            No remittance has been paid at a branch you can see.
          </EmptyTableRow>
        ) : (
          rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell header>
                <DateValue value={row.settlementDate} />
              </TableCell>
              <TableCell>
                {row.providerName}
                <span className="text-text-muted mt-0.5 block text-[10px]">
                  {row.providerCode} · {row.branchCode}
                </span>
              </TableCell>
              <TableCell align="numeric">
                <Money amount={row.settlementAmount} />
              </TableCell>
              <TableCell>
                {row.cashAccountName}
                <span className="text-text-muted mt-0.5 block text-[10px]">
                  {row.cashAccountCode}
                </span>
              </TableCell>
              <TableCell>
                <span className="font-mono text-xs">{row.providerReceiptRef ?? '—'}</span>
              </TableCell>
              <TableCell>
                <AgencySettlementBadge status={row.status} />
              </TableCell>
              <TableCell>
                {row.status === 'reversed' ? (
                  <span className="text-text-muted text-xs">
                    {row.reversalReason ?? 'Reversed.'}
                  </span>
                ) : canReverse ? (
                  <ReverseControl
                    action={reversePayableSettlementAction}
                    settlementId={row.id}
                    hint="Why this payment did not happen as recorded. The cash and the payable both return."
                  />
                ) : (
                  <NotYours />
                )}
              </TableCell>
            </TableRow>
          ))
        )}
      </tbody>
    </DataTable>
  );
}
