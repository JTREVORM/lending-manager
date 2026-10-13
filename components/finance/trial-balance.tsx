import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { FieldTable } from '@/components/reports/field-table';
import { Money } from '@/components/ui/money';
import { trialBalanceFields } from '@/lib/reports/fields';
import type { TrialBalanceSummary } from '@/lib/domain/trial-balance';

/**
 * The trial balance.
 *
 * ## It computes nothing
 *
 * Every figure here comes from `summariseTrialBalance`, which arranges the
 * rows of `public.trial_balance` and nothing else. This component places them
 * and says whether they foot.
 *
 * ## The columns are the export's columns
 *
 * `FieldTable` renders `trialBalanceFields()`, which is the same array the CSV
 * and the letterheaded PDF are built from — so the statement on screen, the
 * spreadsheet and the document cannot show different columns, different
 * headings or differently-formatted money.
 *
 * ## It foots twice, deliberately
 *
 * Once in the table's `<tfoot>`, where a trial balance belongs and where a
 * printout carries it; and once in a panel below, because the table is hidden
 * below `md` in favour of cards and a trial balance whose totals vanished on
 * a phone would be a trial balance nobody could check on a phone.
 *
 * ## An out-of-balance ledger is stated, loudly
 *
 * Not hidden, not tolerated, and not rounded away: these are whole shillings
 * in integer arithmetic, so a difference of one shilling is a real defect in
 * the books rather than a rounding artefact. The database makes it close to
 * impossible — a deferred constraint trigger refuses an unbalanced journal
 * entry whatever writes it — which is exactly why a difference appearing here
 * would matter enough to say first and in red.
 */
export function TrialBalance({ summary }: { readonly summary: TrialBalanceSummary }) {
  const fields = trialBalanceFields();

  return (
    <div className="min-w-0 space-y-4">
      {summary.balanced ? null : (
        <Alert tone="danger" title="This trial balance does not balance">
          Debits and credits do not foot to the same figure — the difference is{' '}
          <strong>
            <Money amount={summary.movementDifference} />
          </strong>
          . Every journal entry is checked for balance as it is written, so this should
          not be possible. Do not report from this screen; raise it with your
          administrator.
        </Alert>
      )}

      <FieldTable
        fields={fields}
        rows={summary.lines}
        rowKey={(line) => line.code}
        caption="Trial balance: every ledger account with its debit and credit movement and its net balance"
        // A phone gets what a trial balance is read for: which account, and
        // what it holds. The movement columns stay in the table.
        compactFor={['Code', 'Account', 'Debit balance (UGX)', 'Credit balance (UGX)']}
        // An account with nothing posted to it is still a row — the chart does
        // not shrink because a month was quiet — but it is not what a reader
        // is looking at.
        rowTone={(line) => (line.movement ? undefined : 'muted')}
        footer={
          <tr className="border-border bg-surface-sunken border-t-2 font-semibold">
            <th scope="row" colSpan={3} className="px-2 py-2.5 text-left">
              Totals
            </th>
            <td className="px-2 py-2.5 text-right tabular-nums">
              <Money amount={summary.totalDebit} variant="bare" />
            </td>
            <td className="px-2 py-2.5 text-right tabular-nums">
              <Money amount={summary.totalCredit} variant="bare" />
            </td>
            <td className="px-2 py-2.5 text-right tabular-nums">
              <Money amount={summary.debitBalanceTotal} variant="bare" />
            </td>
            <td className="px-2 py-2.5 text-right tabular-nums">
              <Money amount={summary.creditBalanceTotal} variant="bare" />
            </td>
          </tr>
        }
      />

      <Card className="min-w-0">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-text text-base font-semibold">The foot of the statement</h2>
          <Badge tone={summary.balanced ? 'success' : 'danger'}>
            {summary.balanced ? 'Balanced' : 'Out of balance'}
          </Badge>
        </div>

        <dl className="mt-3 grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Foot label="Total debits" amount={summary.totalDebit} />
          <Foot label="Total credits" amount={summary.totalCredit} />
          <Foot label="Debit balances" amount={summary.debitBalanceTotal} />
          <Foot label="Credit balances" amount={summary.creditBalanceTotal} />
        </dl>

        <dl className="border-border mt-4 grid min-w-0 gap-4 border-t pt-4 sm:grid-cols-2">
          <Foot
            label="Difference on movement"
            amount={summary.movementDifference}
            tone={summary.movementDifference === 0 ? 'neutral' : 'danger'}
          />
          <Foot
            label="Difference on balances"
            amount={summary.balanceDifference}
            tone={summary.balanceDifference === 0 ? 'neutral' : 'danger'}
          />
        </dl>

        <p className="text-text-muted mt-3 text-xs">
          {String(summary.accountsWithMovement)} of {String(summary.accountCount)}{' '}
          {summary.accountCount === 1 ? 'account has' : 'accounts have'} movement.
        </p>
      </Card>
    </div>
  );
}

function Foot({
  label,
  amount,
  tone = 'neutral',
}: {
  readonly label: string;
  readonly amount: number;
  readonly tone?: 'neutral' | 'danger';
}) {
  return (
    <div className="min-w-0">
      <dt className="t-label">{label}</dt>
      <dd
        className={
          tone === 'danger'
            ? 'text-danger mt-0.5 text-lg font-semibold tabular-nums'
            : 'text-text mt-0.5 text-lg font-semibold tabular-nums'
        }
      >
        <Money amount={amount} />
      </dd>
    </div>
  );
}
