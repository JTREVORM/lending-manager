import { Card } from '@/components/ui/card';
import { DateValue } from '@/components/ui/data-value';
import { getLoanCollections } from '@/lib/data/policy-update';
import { businessToday } from '@/lib/domain/datetime';
import { PolicyAmount } from './amount';
import { OperationForm } from './operation-form';

export async function LoanCollections({ loanId, canCarry }: { readonly loanId: string; readonly canCarry: boolean }) {
  const rows = await getLoanCollections(loanId);
  return <Card>
    <h2 className="text-text font-semibold">Installment carry-forward report</h2>
    <p>The contractual due dates and amounts stay unchanged. Collection periods identify when unpaid amounts are being followed up.</p>
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Contractual due dates, collection periods and outstanding amounts</caption>
        <thead><tr><th scope="col">Installment</th><th scope="col">Contractual due date</th><th scope="col">Collection month</th><th scope="col">Unpaid</th><th scope="col">Days overdue</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.installment_id}>
          <th scope="row">{row.installment_number}</th><td><DateValue value={row.original_due_date} /></td>
          <td><DateValue value={row.collection_period} /></td><td><PolicyAmount value={row.remaining_amount} /></td><td>{row.days_past_due}</td>
        </tr>)}</tbody>
      </table>
    </div>
    {canCarry ? <div className="mt-4"><OperationForm operation="carry_forward"
      values={{ loanId, asOf: businessToday() }} label="Carry unpaid installments to next month"
      fields={[{ name: 'note', label: 'Collection note', required: true }]} /></div> : null}
  </Card>;
}
