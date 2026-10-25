import { notFound } from 'next/navigation';
import { FileText } from 'lucide-react';

import { SavingsStatementTable } from '@/components/savings/savings-statement';
import { Card } from '@/components/ui/card';
import { DateValue } from '@/components/ui/data-value';
import { Input } from '@/components/ui/input';
import { Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { getSavingsAccount, getSavingsStatement } from '@/lib/data/savings';
import { businessToday } from '@/lib/domain/datetime';
import { toUgx } from '@/lib/domain/money';
import { savingsStatementSchema } from '@/lib/validation/savings';
import { uuidSchema } from '@/lib/validation/common';

export const metadata = { title: 'Savings statement' };

/**
 * A savings statement for a period, to print or hand over.
 *
 * ## The opening balance is real
 *
 * `savings_statement` runs its window over the whole account and applies the
 * period filter afterwards, so the first row of a March statement carries the
 * balance March actually opened at. That is why the opening and closing
 * figures below can be read straight off the first and last rows rather than
 * recomputed here — and why they agree with the account page and with the
 * ledger.
 *
 * ## The form is a plain GET
 *
 * No client component, no state: the period is in the URL, so a statement is
 * a link somebody can bookmark, send to a colleague or reload after printing.
 * An invalid period falls back to the whole history rather than erroring,
 * because a date typed wrong should not replace the member's statement with a
 * stack trace.
 */
export default async function SavingsStatementPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly savingsAccountId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { savingsAccountId } = await params;

  if (!uuidSchema.safeParse(savingsAccountId).success) notFound();

  await guardPermission(`${ROUTES.savings}/${savingsAccountId}`, 'savings:view');

  const query = await searchParams;
  const single = (key: string): string =>
    typeof query[key] === 'string' ? query[key] : '';

  const parsed = savingsStatementSchema.safeParse({
    savingsAccountId,
    from: single('from'),
    to: single('to'),
  });

  // The parsed input is kept whole rather than destructured into strings: its
  // dates are branded, and widening them here would lose the guarantee that
  // what reaches the query is a date that exists.
  const input = parsed.success
    ? parsed.data
    : { savingsAccountId, from: undefined, to: undefined };

  const period = { from: input.from ?? '', to: input.to ?? '' };

  const [account, lines] = await Promise.all([
    getSavingsAccount(savingsAccountId),
    getSavingsStatement(input),
  ]);

  if (account === null) notFound();

  const first = lines[0];
  const last = lines.at(-1);

  // The balance the period opened at: the first row's running balance less
  // that row's own effect. Read off the database's figures rather than summed
  // here, so the two cannot disagree.
  const openingBalance =
    first === undefined ? account.balance : first.runningBalance - first.signedAmount;
  const closingBalance = last === undefined ? openingBalance : last.runningBalance;

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        eyebrow="Member Savings"
        icon={FileText}
        back={{
          href: `${ROUTES.savings}/${savingsAccountId}`,
          label: account.fullName,
        }}
        title="Savings statement"
        description={`${account.fullName} · account ${account.accountNumber} · membership ${account.membershipNumber}`}
      />

      {/* `print:hidden`: the period picker is a control, not part of the
          document somebody is handed. */}
      <Card className="print:hidden">
        <form method="get" className="flex min-w-0 flex-wrap items-end gap-3">
          <div className="min-w-0">
            <label
              htmlFor="statement-from"
              className="text-text mb-1 block text-sm font-medium"
            >
              From
            </label>
            <Input
              id="statement-from"
              name="from"
              type="date"
              defaultValue={period.from}
              max={businessToday()}
            />
          </div>
          <div className="min-w-0">
            <label
              htmlFor="statement-to"
              className="text-text mb-1 block text-sm font-medium"
            >
              To
            </label>
            <Input
              id="statement-to"
              name="to"
              type="date"
              defaultValue={period.to}
              max={businessToday()}
            />
          </div>
          <button
            type="submit"
            className="bg-accent text-accent-contrast focus-visible:outline-accent inline-flex min-h-11 items-center justify-center rounded-lg px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Show
          </button>
          {period.from === '' && period.to === '' ? null : (
            <a
              href={`${ROUTES.savings}/${savingsAccountId}/statement`}
              className="text-text-muted hover:text-accent inline-flex min-h-11 items-center text-sm underline-offset-2 hover:underline"
            >
              Whole history
            </a>
          )}
        </form>
      </Card>

      {/* The statement's own header, which prints. */}
      <Card>
        <dl className="grid min-w-0 gap-4 sm:grid-cols-4">
          <div className="min-w-0">
            <dt className="text-text-muted text-xs">Period</dt>
            <dd className="text-text mt-0.5 text-sm">
              {period.from === '' && period.to === '' ? (
                'The whole history of this account'
              ) : (
                <>
                  {period.from === '' ? (
                    'From the beginning'
                  ) : (
                    <DateValue value={period.from} />
                  )}
                  {' to '}
                  {period.to === '' ? 'today' : <DateValue value={period.to} />}
                </>
              )}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-text-muted text-xs">Opening balance</dt>
            <dd className="text-text mt-0.5 tabular-nums">
              <Money amount={toUgx(openingBalance)} />
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-text-muted text-xs">Closing balance</dt>
            <dd className="text-text mt-0.5 tabular-nums">
              <Money amount={toUgx(closingBalance)} weight="semibold" />
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-text-muted text-xs">Movements</dt>
            <dd className="text-text mt-0.5 tabular-nums">{lines.length}</dd>
          </div>
        </dl>
      </Card>

      <SavingsStatementTable lines={lines} accountNumber={account.accountNumber} />

      <p className="text-text-muted text-xs">
        Every figure on this statement is derived from the savings ledger. A corrected
        entry appears as a reversal naming the entry it corrects, rather than as a changed
        figure — so a statement printed earlier still agrees with this one.
      </p>
    </div>
  );
}
