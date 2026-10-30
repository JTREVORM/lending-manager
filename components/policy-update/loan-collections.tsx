import { Card } from '@/components/ui/card';
import { DataTable, TableCell, TableHead, TableRow } from '@/components/ui/data-table';
import { DateValue } from '@/components/ui/data-value';
import { getLoanCollections } from '@/lib/data/policy-update';
import { businessToday } from '@/lib/domain/datetime';
import { PolicyAmount } from './amount';
import { OperationForm } from './operation-form';

export async function LoanCollections({
  loanId,
  canCarry,
}: {
  readonly loanId: string;
  readonly canCarry: boolean;
}) {
  const rows = await getLoanCollections(loanId);
  return (
    <Card>
      <h2 className="text-text font-semibold">Installment carry-forward report</h2>
      <p>
        The contractual due dates and amounts stay unchanged. Collection periods identify
        when unpaid amounts are being followed up.
      </p>
      <div className="mt-3">
        <DataTable caption="Contractual due dates, collection periods and outstanding amounts">
          <thead>
            <TableRow>
              <TableHead width="count">Installment</TableHead>
              <TableHead width="date">Contractual due date</TableHead>
              <TableHead width="date">Collection month</TableHead>
              <TableHead width="money" align="numeric">
                Unpaid
              </TableHead>
              <TableHead width="count" align="numeric">
                Days overdue
              </TableHead>
            </TableRow>
          </thead>
          <tbody>
            {rows.map((row) => (
              <TableRow key={row.installment_id}>
                <TableCell header width="count">
                  {row.installment_number}
                </TableCell>
                <TableCell width="date">
                  <DateValue value={row.original_due_date} />
                </TableCell>
                <TableCell width="date">
                  <DateValue value={row.collection_period} />
                </TableCell>
                <TableCell width="money" align="numeric">
                  <PolicyAmount value={row.remaining_amount} />
                </TableCell>
                <TableCell width="count" align="numeric">
                  {row.days_past_due}
                </TableCell>
              </TableRow>
            ))}
          </tbody>
        </DataTable>
      </div>
      {canCarry ? (
        <div className="mt-4">
          <OperationForm
            operation="carry_forward"
            values={{ loanId, asOf: businessToday() }}
            label="Carry unpaid installments to next month"
            fields={[{ name: 'note', label: 'Collection note', required: true }]}
          />
        </div>
      ) : null}
    </Card>
  );
}
