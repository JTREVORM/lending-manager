import { Card } from '@/components/ui/card';
import { DataTable, TableCell, TableHead, TableRow } from '@/components/ui/data-table';
import { Money } from '@/components/ui/money';
import type { BenefitExpenseLine, BenefitSummary } from '@/lib/data/benefits';
import { BENEFIT_CLAIM_TYPE_LABELS } from '@/lib/domain/benefits';
import { UGX_ZERO, addUgx, type UgxAmount } from '@/lib/domain/money';

/**
 * What the benefits scheme cost over a period, and whether the two sources
 * agree.
 *
 * ## Two figures that must match, shown side by side
 *
 * The upper table comes from `benefit_summary`, which counts
 * `benefit_payments`. The lower one comes from `benefit_expense_by_type`,
 * which sums journal lines on `5210`, `5220` and `5230`. They are two
 * independent paths to the same number, and this screen puts them next to
 * each other on purpose: a report that read one source could not tell anybody
 * when they disagreed.
 *
 * `tests/db/benefit-accounting.test.ts` asserts the equality after every
 * payment and every reversal. So a difference appearing here is a real defect
 * and not a rounding story — which is precisely why it is worth showing a
 * manager rather than hiding behind a reconciliation job.
 *
 * ## The ledger half is absent for a reader without `reports:view_financial`
 *
 * `getBenefitExpenseByType` returns `null` for them, and the section is
 * omitted rather than zeroed. Who may read the company's expense accounts is a
 * financial-reporting question, not a benefits one.
 */
export function BenefitReportView({
  summary,
  expense,
  periodLabel,
}: {
  readonly summary: BenefitSummary | null;
  readonly expense: readonly BenefitExpenseLine[] | null;
  readonly periodLabel: string;
}) {
  if (summary === null) return null;

  const paidByType: readonly {
    readonly label: string;
    readonly amount: UgxAmount;
  }[] = [
    { label: BENEFIT_CLAIM_TYPE_LABELS.medical, amount: summary.paidMedical },
    {
      label: BENEFIT_CLAIM_TYPE_LABELS.family_condolence,
      amount: summary.paidCondolence,
    },
    {
      label: BENEFIT_CLAIM_TYPE_LABELS.member_bereavement,
      amount: summary.paidBereavement,
    },
  ];

  const ledgerTotal =
    expense === null
      ? null
      : expense.reduce<UgxAmount>(
          (total, line) => addUgx(total, line.netExpense),
          UGX_ZERO,
        );

  return (
    <div className="min-w-0 space-y-6">
      <Card>
        <h2 className="text-text text-sm font-semibold">Benefits paid · {periodLabel}</h2>
        <p className="text-text-muted mt-1 text-sm">
          Counted from the payment records. {summary.claimsPaid}{' '}
          {summary.claimsPaid === 1 ? 'claim was' : 'claims were'} paid.
        </p>

        <DataTable caption={`Benefits paid by promise, ${periodLabel}`} className="mt-3">
          <thead>
            <tr>
              <TableHead width="name-wide">Benefit</TableHead>
              <TableHead width="money" align="numeric">
                Paid
              </TableHead>
            </tr>
          </thead>
          <tbody>
            {paidByType.map((line) => (
              <TableRow key={line.label}>
                <TableCell width="name-wide">{line.label}</TableCell>
                <TableCell width="money" align="numeric">
                  <Money amount={line.amount} />
                </TableCell>
              </TableRow>
            ))}
            <TableRow>
              <TableCell width="name-wide" className="font-semibold">
                Total paid
              </TableCell>
              <TableCell width="money" align="numeric">
                <Money amount={summary.paidTotal} weight="semibold" />
              </TableCell>
            </TableRow>
          </tbody>
        </DataTable>

        {summary.paymentsReversed === 0 ? null : (
          <p className="text-text-muted mt-3 text-xs">
            {summary.paymentsReversed}{' '}
            {summary.paymentsReversed === 1 ? 'payment was' : 'payments were'} reversed in
            this period, <Money amount={summary.reversedTotal} /> in all. The totals above
            are net of them, because the contra entries are in the same period.
          </p>
        )}
      </Card>

      {expense === null ? (
        <Card>
          <h2 className="text-text text-sm font-semibold">
            Benefits expense in the General Ledger
          </h2>
          <p className="text-text-muted mt-1 text-sm">
            Reading the company&rsquo;s expense accounts needs the financial reporting
            permission. The payment figures above are what you are entitled to.
          </p>
        </Card>
      ) : (
        <Card>
          <h2 className="text-text text-sm font-semibold">
            The same period, from the General Ledger
          </h2>
          <p className="text-text-muted mt-1 text-sm">
            Summed from journal lines, not from the claim table. The two totals are
            independent and must agree.
          </p>

          <DataTable
            caption={`Benefits expense by account, ${periodLabel}`}
            className="mt-3"
          >
            <thead>
              <tr>
                <TableHead width="ref">Account</TableHead>
                <TableHead width="name-wide">Name</TableHead>
                <TableHead width="money" align="numeric" hideBelow="lg">
                  Debits
                </TableHead>
                <TableHead width="money" align="numeric" hideBelow="lg">
                  Credits
                </TableHead>
                <TableHead width="money" align="numeric">
                  Net expense
                </TableHead>
              </tr>
            </thead>
            <tbody>
              {expense.map((line) => (
                <TableRow key={line.accountCode}>
                  <TableCell width="ref" className="font-mono">
                    {line.accountCode}
                  </TableCell>
                  <TableCell width="name-wide">{line.accountName}</TableCell>
                  <TableCell width="money" align="numeric" hideBelow="lg">
                    <Money amount={line.postedDebits} />
                  </TableCell>
                  <TableCell width="money" align="numeric" hideBelow="lg">
                    <Money amount={line.postedCredits} />
                  </TableCell>
                  <TableCell width="money" align="numeric">
                    <Money amount={line.netExpense} />
                  </TableCell>
                </TableRow>
              ))}
              {ledgerTotal === null ? null : (
                <TableRow>
                  <TableCell width="ref">{''}</TableCell>
                  <TableCell width="name-wide" className="font-semibold">
                    Total expense
                  </TableCell>
                  <TableCell width="money" align="numeric" hideBelow="lg">
                    {''}
                  </TableCell>
                  <TableCell width="money" align="numeric" hideBelow="lg">
                    {''}
                  </TableCell>
                  <TableCell width="money" align="numeric">
                    <Money amount={ledgerTotal} weight="semibold" />
                  </TableCell>
                </TableRow>
              )}
            </tbody>
          </DataTable>

          {ledgerTotal === null ? null : (
            <p
              className={
                ledgerTotal === summary.paidTotal
                  ? 'text-success mt-3 text-sm font-medium'
                  : 'text-danger mt-3 text-sm font-medium'
              }
            >
              {ledgerTotal === summary.paidTotal
                ? 'The payment records and the General Ledger agree.'
                : 'These two totals disagree. That is a defect, not a rounding difference — report it before relying on either figure.'}
            </p>
          )}
        </Card>
      )}

      <Card>
        <h2 className="text-text text-sm font-semibold">Claims in this period</h2>
        <dl className="mt-3 grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Figure label="Opened in all" value={summary.claimsTotal} />
          <Figure label="Paid" value={summary.claimsPaid} />
          <Figure label="Refused" value={summary.claimsRejected} />
          <Figure
            label="Still open"
            value={
              summary.claimsDraft +
              summary.claimsSubmitted +
              summary.claimsUnderVerification +
              summary.claimsInformationRequired +
              summary.claimsAssessed +
              summary.claimsApproved
            }
          />
        </dl>
      </Card>

      <Card>
        <h2 className="text-text text-sm font-semibold">
          Next of kin, and meetings in this period
        </h2>
        <dl className="mt-3 grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Figure
            label="Members with a verified next of kin"
            value={summary.membersWithVerifiedBeneficiary}
            hint={`of ${String(summary.liveMemberships)} live memberships`}
          />
          <Figure
            label="Registered, awaiting a check"
            value={summary.beneficiariesAwaitingVerification}
            hint="Each one is a bereavement benefit that cannot be paid yet"
          />
          <Figure label="Meetings held" value={summary.meetingsHeldInPeriod} />
          <Figure
            label="Attendance recorded"
            value={summary.attendanceRecordedInPeriod}
            hint={`${String(summary.meetingActionsOpen)} action items still open`}
          />
        </dl>
      </Card>
    </div>
  );
}

function Figure({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: number;
  readonly hint?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-text-muted text-xs">{label}</dt>
      <dd className="text-text mt-0.5 text-lg font-semibold tabular-nums">{value}</dd>
      {hint === undefined ? null : (
        <dd className="text-text-muted mt-0.5 text-xs">{hint}</dd>
      )}
    </div>
  );
}
