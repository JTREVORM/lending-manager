'use client';

import { useActionState, useId, useState } from 'react';

import { AgencyReconciliationBadge, VarianceBadge } from '@/components/agency/badges';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DataTable, TableCell, TableHead, TableRow } from '@/components/ui/data-table';
import { DateValue } from '@/components/ui/data-value';
import { Field } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import { Money } from '@/components/ui/money';
import { EmptyTableRow } from '@/components/ui/states';
import {
  approveCashCountAction,
  approveFloatStatementAction,
  submitCashCountAction,
  submitFloatStatementAction,
  type AgencyActionResult,
} from '@/lib/agency/actions';
import type {
  AgencyCashCountRow,
  AgencyFloatRow,
  AgencyFloatStatementRow,
} from '@/lib/domain/agency';

/** A cash account a drawer can be counted against. */
export interface CountableAccount {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly branchId: string | null;
}

const SELECT =
  'border-border bg-surface focus-visible:ring-brand h-11 w-full min-w-0 rounded-lg border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none';

/**
 * Why no form here subtracts anything.
 *
 * A reconciliation is a reading, not a calculation: the officer enters what
 * they counted or what the provider's statement says, and the database works
 * out the variance against the balance it holds under lock. A form that
 * showed its own difference would be showing a figure that could already be
 * wrong by the time the button was pressed, and would look authoritative
 * doing it. The system figure beside each field is there to be compared with,
 * not to be arithmetic on.
 */

// ---------------------------------------------------------------------------
// Recording a reading
// ---------------------------------------------------------------------------

export function CashCountForm({
  accounts,
}: {
  readonly accounts: readonly CountableAccount[];
}) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(submitCashCountAction, undefined);
  const formId = useId();

  if (accounts.length === 0) {
    return (
      <Alert tone="info">
        No cash account at a branch you can see. There is nothing to count here.
      </Alert>
    );
  }

  return (
    <Card>
      <h2 className="text-sm font-semibold">Record a physical count</h2>
      <p className="text-text-muted mt-1 text-xs">
        Count the drawer, then enter what is in it. A second officer certifies the
        reading, and only an Owner can write a difference off.
      </p>
      <form action={submit} className="mt-3 min-w-0 space-y-4">
        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${formId}-account`}>Account counted</Label>
          <select
            id={`${formId}-account`}
            name="cashAccountId"
            required
            className={SELECT}
          >
            {accounts.map((a) => (
              <option key={a.accountId} value={a.accountId}>
                {a.name} ({a.code})
              </option>
            ))}
          </select>
        </div>

        <Field
          label="Counted (UGX)"
          name="physicalCount"
          inputMode="numeric"
          required
          hint="What is physically there. An empty drawer is a real reading: enter zero."
          error={result?.fieldErrors?.physicalCount?.[0]}
        />

        <Field
          label="Date counted"
          name="reconciliationDate"
          type="date"
          hint="Today, unless the count was taken on an earlier day."
          error={result?.fieldErrors?.reconciliationDate?.[0]}
        />

        <Field
          label="Notes"
          name="notes"
          autoComplete="off"
          hint="Optional. Anything the next officer should know about the count."
          error={result?.fieldErrors?.notes?.[0]}
        />

        <Button type="submit" loading={pending} className="w-full sm:w-auto">
          Record count
        </Button>
        {result === undefined ? null : (
          <Alert tone={result.ok ? 'success' : 'danger'}>{result.message}</Alert>
        )}
      </form>
    </Card>
  );
}

export function FloatStatementForm({
  tills,
}: {
  readonly tills: readonly AgencyFloatRow[];
}) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(submitFloatStatementAction, undefined);
  const formId = useId();

  if (tills.length === 0) {
    return (
      <Alert tone="info">
        No float till at a branch you can see. There is nothing to reconcile here.
      </Alert>
    );
  }

  return (
    <Card>
      <h2 className="text-sm font-semibold">Record a provider statement</h2>
      <p className="text-text-muted mt-1 text-xs">
        Enter the balance the provider&rsquo;s own system shows for this till. The
        difference against our books is the database&rsquo;s to work out.
      </p>
      <form action={submit} className="mt-3 min-w-0 space-y-4">
        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${formId}-till`}>Float till</Label>
          <select id={`${formId}-till`} name="floatAccountId" required className={SELECT}>
            {tills.map((t) => (
              <option key={t.floatAccountId} value={t.floatAccountId}>
                {t.providerName} — {t.tillName} ({t.branchCode}), our books say{' '}
                {t.balance.toLocaleString('en-UG')}
              </option>
            ))}
          </select>
        </div>

        <Field
          label="Provider statement balance (UGX)"
          name="statementBalance"
          inputMode="numeric"
          required
          hint="Exactly what the provider's statement says, even if it looks wrong. Zero is a reading."
          error={result?.fieldErrors?.statementBalance?.[0]}
        />

        <Field
          label="Statement reference"
          name="statementRef"
          autoComplete="off"
          hint="Optional. The statement number or download the figure came from."
          error={result?.fieldErrors?.statementRef?.[0]}
        />

        <Field
          label="Statement date"
          name="reconciliationDate"
          type="date"
          hint="The date the statement closes, not the day you read it."
          error={result?.fieldErrors?.reconciliationDate?.[0]}
        />

        <Field
          label="Notes"
          name="notes"
          autoComplete="off"
          hint="Optional."
          error={result?.fieldErrors?.notes?.[0]}
        />

        <Button type="submit" loading={pending} className="w-full sm:w-auto">
          Record statement
        </Button>
        {result === undefined ? null : (
          <Alert tone={result.ok ? 'success' : 'danger'}>{result.message}</Alert>
        )}
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Certifying a reading
// ---------------------------------------------------------------------------

type Action = (
  previous: AgencyActionResult | undefined,
  formData: FormData,
) => Promise<AgencyActionResult>;

/**
 * The certification control for one reading.
 *
 * Writing a difference off is a second decision inside the first, so it is a
 * checkbox that reveals a reason rather than a separate button: an officer
 * certifying a count that agrees should not have to think about the write-off
 * path at all. Both the capability and the reason are the database's to
 * require - it refuses a write-off without `agency:variance_adjustment` and
 * without a reason, whatever this form sends.
 */
function CertifyControl({
  action,
  reconciliationId,
  variance,
  canAdjust,
  blocked,
}: {
  readonly action: Action;
  readonly reconciliationId: string;
  readonly variance: number;
  readonly canAdjust: boolean;
  /** Why this reading cannot be certified right now, if it cannot. */
  readonly blocked: string | null;
}) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(action, undefined);
  const [adjust, setAdjust] = useState(false);
  const fieldId = useId();

  if (blocked !== null) {
    return (
      <p className="text-text-muted text-xs" role="note">
        {blocked}
      </p>
    );
  }

  return (
    <form action={submit} className="min-w-0 space-y-2">
      <input type="hidden" name="reconciliationId" value={reconciliationId} />
      {variance === 0 ? null : canAdjust ? (
        <div className="min-w-0 space-y-2">
          <label className="flex min-w-0 items-start gap-2 text-xs">
            <input
              type="checkbox"
              name="adjust"
              checked={adjust}
              onChange={(event) => setAdjust(event.target.checked)}
              className="mt-0.5"
              aria-describedby={`${fieldId}-hint`}
            />
            <span>Write the difference into the ledger as a shortage or overage</span>
          </label>
          <p id={`${fieldId}-hint`} className="text-text-muted text-[10px]">
            Posts the difference to GL 5950. Leave it unticked to certify the reading and
            leave the difference outstanding.
          </p>
          {adjust ? (
            <Field
              label="Reason for the write-off"
              name="reason"
              required
              autoComplete="off"
              hint="Required. Stated in the journal narration."
              error={result?.fieldErrors?.reason?.[0]}
            />
          ) : null}
        </div>
      ) : (
        <p className="text-text-muted text-xs" role="note">
          This reading differs from the books. Writing a difference off is the
          Owner&rsquo;s, so certify it and leave the difference for them.
        </p>
      )}
      <Button type="submit" size="sm" variant="primary" loading={pending}>
        {adjust ? 'Certify and write off' : 'Certify'}
      </Button>
      {result === undefined ? null : (
        <Alert tone={result.ok ? 'success' : 'danger'}>{result.message}</Alert>
      )}
    </form>
  );
}

/**
 * Why a reading can be refused before its button is pressed.
 *
 * Both of these are the database's refusals, restated here so an officer is
 * not sent into one. The `balanceMoved` case is the Phase 4C stale-count
 * rule: an account that has moved since the drawer was counted makes the
 * variance meaningless, so approval refuses it and the count has to be taken
 * again. This screen's reading of the balance is a moment older than the one
 * approval locks, which is exactly why the refusal stays in the database.
 */
function blockedReason(
  row: {
    readonly status: string;
    readonly balanceMoved: boolean;
    readonly createdBy: string | null;
  },
  viewer: { readonly profileId: string },
): string | null {
  if (row.status !== 'open') return null;
  if (row.createdBy === viewer.profileId) {
    return 'You recorded this reading, so you cannot certify it. A second officer must.';
  }
  if (row.balanceMoved) {
    return 'The account has moved since this reading was taken, so its difference no longer describes anything. Take the reading again against the current balance.';
  }
  return null;
}

export function CashCountRegister({
  rows,
  profileId,
  canAdjust,
}: {
  readonly rows: readonly AgencyCashCountRow[];
  readonly profileId: string;
  readonly canAdjust: boolean;
}) {
  return (
    <DataTable caption="Physical cash counts" stickyHeader>
      <thead>
        <tr>
          <TableHead width="date">Date</TableHead>
          <TableHead width="name">Account</TableHead>
          <TableHead align="numeric" width="money">
            Books said
          </TableHead>
          <TableHead align="numeric" width="money">
            Counted
          </TableHead>
          <TableHead width="ref">Difference</TableHead>
          <TableHead align="numeric" width="money">
            Books say now
          </TableHead>
          <TableHead width="status-wide">Status</TableHead>
          <TableHead width="prose">Certification</TableHead>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <EmptyTableRow colSpan={8}>
            No cash count has been recorded at a branch you can see.
          </EmptyTableRow>
        ) : (
          rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell header>
                <DateValue value={row.reconciliationDate} />
              </TableCell>
              <TableCell>
                {row.accountName}
                <span className="text-text-muted mt-0.5 block text-[10px]">
                  {row.accountCode} · {row.branchCode}
                </span>
              </TableCell>
              <TableCell align="numeric">
                <Money amount={row.systemClosingBalance} />
              </TableCell>
              <TableCell align="numeric">
                <Money amount={row.physicalCount} />
              </TableCell>
              <TableCell>
                <VarianceBadge variance={row.variance} means={row.varianceMeans} />
              </TableCell>
              <TableCell align="numeric">
                <Money amount={row.currentSystemBalance} />
              </TableCell>
              <TableCell>
                <AgencyReconciliationBadge status={row.status} />
              </TableCell>
              <TableCell>
                {row.status === 'open' ? (
                  <CertifyControl
                    action={approveCashCountAction}
                    reconciliationId={row.id}
                    variance={row.variance}
                    canAdjust={canAdjust}
                    blocked={blockedReason(row, { profileId })}
                  />
                ) : (
                  <span className="text-text-muted text-xs">
                    {row.varianceJournalEntryId === null
                      ? 'Certified. Difference left outstanding.'
                      : 'Certified and written off.'}
                  </span>
                )}
              </TableCell>
            </TableRow>
          ))
        )}
      </tbody>
    </DataTable>
  );
}

export function FloatStatementRegister({
  rows,
  profileId,
  canAdjust,
}: {
  readonly rows: readonly AgencyFloatStatementRow[];
  readonly profileId: string;
  readonly canAdjust: boolean;
}) {
  return (
    <DataTable caption="Provider float statements" stickyHeader>
      <thead>
        <tr>
          <TableHead width="date">Date</TableHead>
          <TableHead width="name">Till</TableHead>
          <TableHead align="numeric" width="money">
            Books said
          </TableHead>
          <TableHead align="numeric" width="money">
            Provider said
          </TableHead>
          <TableHead width="ref">Difference</TableHead>
          <TableHead align="numeric" width="money">
            Books say now
          </TableHead>
          <TableHead width="ref">Statement</TableHead>
          <TableHead width="status-wide">Status</TableHead>
          <TableHead width="prose">Certification</TableHead>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <EmptyTableRow colSpan={9}>
            No provider statement has been recorded at a branch you can see.
          </EmptyTableRow>
        ) : (
          rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell header>
                <DateValue value={row.reconciliationDate} />
              </TableCell>
              <TableCell>
                {row.providerName ?? row.accountName}
                <span className="text-text-muted mt-0.5 block text-[10px]">
                  {row.tillName} · {row.branchCode ?? '—'}
                </span>
              </TableCell>
              <TableCell align="numeric">
                <Money amount={row.systemClosingBalance} />
              </TableCell>
              <TableCell align="numeric">
                <Money amount={row.providerStatementBalance} />
              </TableCell>
              <TableCell>
                <VarianceBadge variance={row.variance} means={row.varianceMeans} />
              </TableCell>
              <TableCell align="numeric">
                <Money amount={row.currentSystemBalance} />
              </TableCell>
              <TableCell>
                <span className="font-mono text-xs">
                  {row.providerStatementRef ?? '—'}
                </span>
              </TableCell>
              <TableCell>
                <AgencyReconciliationBadge status={row.status} />
              </TableCell>
              <TableCell>
                {row.status === 'open' ? (
                  <CertifyControl
                    action={approveFloatStatementAction}
                    reconciliationId={row.id}
                    variance={row.variance}
                    canAdjust={canAdjust}
                    blocked={blockedReason(row, { profileId })}
                  />
                ) : (
                  <span className="text-text-muted text-xs">
                    {row.varianceJournalEntryId === null
                      ? 'Certified. Difference left outstanding.'
                      : 'Certified and written off.'}
                  </span>
                )}
              </TableCell>
            </TableRow>
          ))
        )}
      </tbody>
    </DataTable>
  );
}
