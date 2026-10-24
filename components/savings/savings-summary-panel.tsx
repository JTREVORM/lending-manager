import { Card } from '@/components/ui/card';
import { Money } from '@/components/ui/money';
import type { SavingsSummary } from '@/lib/data/savings';

/**
 * The savings position, for the top of the register and the dashboard.
 *
 * ## Why "owed to members" and not "savings held"
 *
 * The liability is labelled as what the business **owes**, because that is
 * what it is. A deposit is not revenue and not a balance the business owns; it
 * is money held on behalf of a member who will ask for it back. The ledger
 * says so — `2100 Member Savings` is a liability account — and a dashboard
 * that said "savings held: UGX 4,500,000" beside a cash figure would invite
 * exactly the reading that ends with a profit share paid out of deposits.
 *
 * The figure comes from `savings_summary`, which derives it from the subledger,
 * and `tests/db/savings.test.ts` asserts it equals the `2100` ledger balance.
 * So this panel and the trial balance cannot disagree.
 *
 * ## It renders nothing when the caller may not see it
 *
 * `getSavingsSummary` returns `null` when the caller does not hold
 * `savings:view_reports` — a Secretary, who may take deposits all day and may
 * not read the business-wide position. The panel is absent rather than empty
 * or zeroed: a row of zeros would be a lie, and an error would stop a page
 * they are entitled to the rest of.
 */
export function SavingsSummaryPanel({
  summary,
}: {
  readonly summary: SavingsSummary | null;
}) {
  if (summary === null) return null;

  return (
    <Card>
      <h2 className="text-text text-sm font-semibold">The savings position</h2>
      <dl className="mt-3 grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="Owed to members" hint="The business's liability to its savers">
          <Money amount={summary.totalLiability} weight="semibold" size="lg" />
        </Figure>
        <Figure
          label="Accounts open"
          hint={`${String(summary.membersSaving)} have paid in at least once`}
        >
          <span className="text-text text-lg font-semibold tabular-nums">
            {summary.accountsOpen}
          </span>
        </Figure>
        <Figure
          label="Met this month"
          hint="Members who have reached the monthly minimum"
        >
          <span className="text-text text-lg font-semibold tabular-nums">
            {summary.membersMeetingMinimum}
          </span>
        </Figure>
        <Figure
          label="Awaiting a decision"
          hint={
            summary.pendingWithdrawalRequests === 0
              ? 'No withdrawals are waiting'
              : undefined
          }
        >
          <span className="text-text text-lg font-semibold tabular-nums">
            {summary.pendingWithdrawalRequests}
          </span>
          {summary.pendingWithdrawalRequests > 0 ? (
            <span className="text-text-muted block text-xs tabular-nums">
              <Money amount={summary.pendingWithdrawalValue} /> requested
            </span>
          ) : null}
        </Figure>
      </dl>
    </Card>
  );
}

function Figure({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-text-muted text-xs">{label}</dt>
      <dd className="text-text mt-0.5">{children}</dd>
      {hint === undefined ? null : (
        <dd className="text-text-muted mt-0.5 text-xs">{hint}</dd>
      )}
    </div>
  );
}
