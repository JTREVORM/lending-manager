import { DataTable, TableCell, TableHead, TableRow } from '@/components/ui/data-table';
import { DateValue } from '@/components/ui/data-value';
import { EmptyTableRow } from '@/components/ui/states';
import { Money } from '@/components/ui/money';
import { DecisionControls } from '@/components/finance/decision-controls';
import {
  MovementStatusBadge,
  ReconciliationStatusBadge,
} from '@/components/finance/movement-status-badge';
import {
  approveExpenseAction,
  approveReconciliationAction,
  approveTransferAction,
  rejectExpenseAction,
  rejectReconciliationAction,
  rejectTransferAction,
  reverseExpenseAction,
  reverseIncomeAction,
  reverseTransferAction,
} from '@/lib/finance/actions';
import { toUgx } from '@/lib/domain/money';
import type {
  ExpenseRow,
  IncomeRow,
  ReconciliationRow,
  TransferRow,
} from '@/lib/domain/finance';

/**
 * The four registers.
 *
 * Each is a plain Server Component table; only the decision controls are
 * interactive, and they are the one part that has to be. Rendering the rows
 * on the server keeps the register readable with JavaScript still loading,
 * which on a Kampala 3G connection is most of the first second.
 *
 * `canDecide` is passed in rather than read here. Hiding a control is never
 * the protection — the capability is enforced by the action and again by the
 * posting function — it is the courtesy that stops staff pressing a button
 * that will refuse them.
 */

export function TransferRegister({
  rows,
  canDecide,
}: {
  readonly rows: readonly TransferRow[];
  readonly canDecide: boolean;
}) {
  return (
    <DataTable caption="Transfers between the company's own accounts">
      <thead>
        <tr>
          <TableHead>Number</TableHead>
          <TableHead>Date</TableHead>
          <TableHead>Out of</TableHead>
          <TableHead>Into</TableHead>
          <TableHead align="numeric">Amount</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Recorded by</TableHead>
          {canDecide ? <TableHead>Decision</TableHead> : null}
        </tr>
      </thead>
      <tbody className="divide-border/60 divide-y">
        {rows.length === 0 ? (
          <EmptyTableRow colSpan={canDecide ? 8 : 7}>No transfers yet.</EmptyTableRow>
        ) : (
          rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell header>
                <span className="font-mono">{row.transferNumber}</span>
              </TableCell>
              <TableCell>
                <DateValue value={row.transferDate} />
              </TableCell>
              <TableCell>{row.fromAccountName}</TableCell>
              <TableCell>{row.toAccountName}</TableCell>
              <TableCell align="numeric">
                <span className="tabular-nums">
                  <Money amount={row.amount} />
                </span>
              </TableCell>
              <TableCell>
                <MovementStatusBadge status={row.status} />
                {row.decisionReason === null ? null : (
                  <span className="text-text-muted mt-0.5 block text-[10px]">
                    {row.decisionReason}
                  </span>
                )}
              </TableCell>
              <TableCell>{row.initiatedByLabel}</TableCell>
              {canDecide ? (
                <TableCell nowrap={false}>
                  {row.status === 'pending_approval' ? (
                    <DecisionControls
                      idField="transferId"
                      recordId={row.id}
                      approve={{ action: approveTransferAction, label: 'Approve' }}
                      reject={{ action: rejectTransferAction, label: 'Reject' }}
                    />
                  ) : row.status === 'posted' ? (
                    <DecisionControls
                      idField="transferId"
                      recordId={row.id}
                      reverse={{ action: reverseTransferAction, label: 'Reverse' }}
                    />
                  ) : (
                    <span className="text-text-muted text-[11px]">—</span>
                  )}
                </TableCell>
              ) : null}
            </TableRow>
          ))
        )}
      </tbody>
    </DataTable>
  );
}

export function ExpenseRegister({
  rows,
  canDecide,
}: {
  readonly rows: readonly ExpenseRow[];
  readonly canDecide: boolean;
}) {
  return (
    <DataTable caption="Expenses">
      <thead>
        <tr>
          <TableHead>Number</TableHead>
          <TableHead>Date</TableHead>
          <TableHead>Category</TableHead>
          <TableHead>Description</TableHead>
          <TableHead>Paid from</TableHead>
          <TableHead align="numeric">Amount</TableHead>
          <TableHead>Status</TableHead>
          {canDecide ? <TableHead>Decision</TableHead> : null}
        </tr>
      </thead>
      <tbody className="divide-border/60 divide-y">
        {rows.length === 0 ? (
          <EmptyTableRow colSpan={canDecide ? 8 : 7}>No expenses yet.</EmptyTableRow>
        ) : (
          rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell header>
                <span className="font-mono">{row.expenseNumber}</span>
              </TableCell>
              <TableCell>
                <DateValue value={row.expenseDate} />
              </TableCell>
              <TableCell>{row.categoryName}</TableCell>
              <TableCell nowrap={false}>
                {row.description}
                {row.payee === null ? null : (
                  <span className="text-text-muted block text-[10px]">
                    Paid to {row.payee}
                  </span>
                )}
              </TableCell>
              <TableCell>{row.paymentAccountName}</TableCell>
              <TableCell align="numeric">
                <span className="tabular-nums">
                  <Money amount={row.amount} />
                </span>
              </TableCell>
              <TableCell>
                <MovementStatusBadge status={row.status} />
                {row.decisionReason === null ? null : (
                  <span className="text-text-muted mt-0.5 block text-[10px]">
                    {row.decisionReason}
                  </span>
                )}
              </TableCell>
              {canDecide ? (
                <TableCell nowrap={false}>
                  {row.status === 'pending_approval' ? (
                    <DecisionControls
                      idField="expenseId"
                      recordId={row.id}
                      approve={{ action: approveExpenseAction, label: 'Approve' }}
                      reject={{ action: rejectExpenseAction, label: 'Reject' }}
                    />
                  ) : row.status === 'posted' ? (
                    <DecisionControls
                      idField="expenseId"
                      recordId={row.id}
                      reverse={{ action: reverseExpenseAction, label: 'Reverse' }}
                    />
                  ) : (
                    <span className="text-text-muted text-[11px]">—</span>
                  )}
                </TableCell>
              ) : null}
            </TableRow>
          ))
        )}
      </tbody>
    </DataTable>
  );
}

export function IncomeRegister({
  rows,
  canReverse,
}: {
  readonly rows: readonly IncomeRow[];
  readonly canReverse: boolean;
}) {
  return (
    <DataTable caption="Fees and other income">
      <thead>
        <tr>
          <TableHead>Number</TableHead>
          <TableHead>Date</TableHead>
          <TableHead>Category</TableHead>
          <TableHead>Description</TableHead>
          <TableHead>Into</TableHead>
          <TableHead align="numeric">Amount</TableHead>
          <TableHead>Status</TableHead>
          {canReverse ? <TableHead>Decision</TableHead> : null}
        </tr>
      </thead>
      <tbody className="divide-border/60 divide-y">
        {rows.length === 0 ? (
          <EmptyTableRow colSpan={canReverse ? 8 : 7}>
            No income recorded yet.
          </EmptyTableRow>
        ) : (
          rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell header>
                <span className="font-mono">{row.incomeNumber}</span>
              </TableCell>
              <TableCell>
                <DateValue value={row.incomeDate} />
              </TableCell>
              <TableCell>{row.categoryName}</TableCell>
              <TableCell nowrap={false}>
                {row.description}
                {row.clientName === null ? null : (
                  <span className="text-text-muted block text-[10px]">
                    {row.clientName}
                    {row.loanNumber === null ? '' : ` · ${row.loanNumber}`}
                  </span>
                )}
              </TableCell>
              <TableCell>{row.receivingAccountName}</TableCell>
              <TableCell align="numeric">
                <span className="tabular-nums">
                  <Money amount={row.amount} />
                </span>
              </TableCell>
              <TableCell>
                <MovementStatusBadge status={row.status} />
              </TableCell>
              {canReverse ? (
                <TableCell nowrap={false}>
                  {row.status === 'posted' ? (
                    <DecisionControls
                      idField="incomeId"
                      recordId={row.id}
                      reverse={{ action: reverseIncomeAction, label: 'Reverse' }}
                    />
                  ) : (
                    <span className="text-text-muted text-[11px]">—</span>
                  )}
                </TableCell>
              ) : null}
            </TableRow>
          ))
        )}
      </tbody>
    </DataTable>
  );
}

export function ReconciliationRegister({
  rows,
  canDecide,
}: {
  readonly rows: readonly ReconciliationRow[];
  readonly canDecide: boolean;
}) {
  return (
    <DataTable caption="Account reconciliations">
      <thead>
        <tr>
          <TableHead>Number</TableHead>
          <TableHead>Date</TableHead>
          <TableHead>Account</TableHead>
          <TableHead align="numeric">Ledger</TableHead>
          <TableHead align="numeric">Counted</TableHead>
          <TableHead align="numeric">Difference</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Counted by</TableHead>
          {canDecide ? <TableHead>Decision</TableHead> : null}
        </tr>
      </thead>
      <tbody className="divide-border/60 divide-y">
        {rows.length === 0 ? (
          <EmptyTableRow colSpan={canDecide ? 9 : 8}>
            No counts recorded yet.
          </EmptyTableRow>
        ) : (
          rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell header>
                <span className="font-mono">{row.reconciliationNumber}</span>
              </TableCell>
              <TableCell>
                <DateValue value={row.businessDate} />
              </TableCell>
              <TableCell>{row.accountName}</TableCell>
              <TableCell align="numeric">
                <span className="tabular-nums">
                  <Money amount={row.systemBalance} />
                </span>
              </TableCell>
              <TableCell align="numeric">
                <span className="tabular-nums">
                  <Money amount={row.countedBalance} />
                </span>
              </TableCell>
              <TableCell align="numeric">
                {row.variance === 0 ? (
                  <span className="text-text-muted">—</span>
                ) : (
                  // The word carries the meaning; the sign is easy to misread
                  // on a dense row and colour alone is not readable in print.
                  <span
                    className={
                      row.variance > 0
                        ? 'text-info tabular-nums'
                        : 'text-danger tabular-nums'
                    }
                  >
                    {row.variance > 0 ? 'Over ' : 'Short '}
                    <Money amount={toUgx(Math.abs(row.variance))} />
                  </span>
                )}
              </TableCell>
              <TableCell>
                <ReconciliationStatusBadge status={row.status} />
                {row.explanation === null ? null : (
                  <span className="text-text-muted mt-0.5 block text-[10px]">
                    {row.explanation}
                  </span>
                )}
              </TableCell>
              <TableCell>{row.performedByLabel}</TableCell>
              {canDecide ? (
                <TableCell nowrap={false}>
                  {row.status === 'submitted' ? (
                    <DecisionControls
                      idField="reconciliationId"
                      recordId={row.id}
                      approve={{
                        action: approveReconciliationAction,
                        label: 'Write off',
                      }}
                      reject={{ action: rejectReconciliationAction, label: 'Reject' }}
                    />
                  ) : (
                    <span className="text-text-muted text-[11px]">—</span>
                  )}
                </TableCell>
              ) : null}
            </TableRow>
          ))
        )}
      </tbody>
    </DataTable>
  );
}
