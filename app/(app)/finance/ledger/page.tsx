import { ScrollText } from 'lucide-react';

import { DataTable, TableCell, TableHead, TableRow } from '@/components/ui/data-table';
import { DateValue } from '@/components/ui/data-value';
import { EmptyTableRow } from '@/components/ui/states';
import { Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { Badge } from '@/components/ui/badge';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { getLedgerAccounts, getLedgerLines } from '@/lib/data/finance';
import { describeJournalSource } from '@/lib/domain/finance';

export const metadata = { title: 'General ledger' };

/**
 * Every posting, with the event behind it.
 *
 * This is the drill-down under every financial figure in the system. A
 * balance on a card, a total in a report, a line in the trial balance: all of
 * them are sums over these rows, and a reader who wants to know why a figure
 * is what it is ends up here.
 *
 * Narrowed by account through the query string, which is what the balance
 * cards link into.
 */
export default async function GeneralLedgerPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await guardPermission(ROUTES.ledger, 'ledger:view');

  const params = await searchParams;
  const raw = params.account;
  const accountId = Array.isArray(raw) ? raw[0] : raw;

  const [accounts, lines] = await Promise.all([
    getLedgerAccounts(),
    getLedgerLines(accountId === undefined ? { limit: 200 } : { accountId, limit: 200 }),
  ]);

  const selected = accounts.find((account) => account.accountId === accountId);

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        eyebrow="Financial Ledger"
        icon={ScrollText}
        title={selected === undefined ? 'General ledger' : selected.name}
        description={
          selected === undefined
            ? 'Every posting line, newest first.'
            : `Account ${selected.code}. Every posting that touched it.`
        }
        back={{ href: ROUTES.finance, label: 'Finance' }}
        status={
          selected === undefined ? undefined : (
            <Badge tone="info">
              Balance <Money amount={selected.balance} />
            </Badge>
          )
        }
      />

      <nav aria-label="Accounts" className="min-w-0">
        <ul className="flex min-w-0 flex-wrap gap-1.5">
          <li>
            <a
              href={ROUTES.ledger}
              className={
                accountId === undefined
                  ? 'bg-accent-surface text-accent inline-flex min-h-8 items-center rounded-full px-3 text-xs font-semibold'
                  : 'border-border text-text-muted hover:text-accent inline-flex min-h-8 items-center rounded-full border px-3 text-xs'
              }
            >
              All accounts
            </a>
          </li>
          {accounts.map((account) => (
            <li key={account.accountId}>
              <a
                href={`${ROUTES.ledger}?account=${account.accountId}`}
                className={
                  accountId === account.accountId
                    ? 'bg-accent-surface text-accent inline-flex min-h-8 items-center rounded-full px-3 text-xs font-semibold'
                    : 'border-border text-text-muted hover:text-accent inline-flex min-h-8 items-center rounded-full border px-3 text-xs'
                }
              >
                <span className="font-mono">{account.code}</span>
                <span className="ml-1.5">{account.name}</span>
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <DataTable caption="General ledger">
        <thead>
          <tr>
            <TableHead>Entry</TableHead>
            <TableHead>Date</TableHead>
            <TableHead>Event</TableHead>
            <TableHead>Account</TableHead>
            <TableHead>Narrative</TableHead>
            <TableHead align="numeric">Debit</TableHead>
            <TableHead align="numeric">Credit</TableHead>
          </tr>
        </thead>
        <tbody className="divide-border/60 divide-y">
          {lines.length === 0 ? (
            <EmptyTableRow colSpan={7}>Nothing has been posted here yet.</EmptyTableRow>
          ) : (
            lines.map((line) => (
              <TableRow key={line.lineId}>
                <TableCell header>
                  <span className="font-mono">{line.entryNumber}</span>
                  {line.reversedByEntryId === null ? null : (
                    <span className="text-danger ml-1.5 text-[10px] font-medium">
                      reversed
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <DateValue value={line.entryDate} />
                </TableCell>
                <TableCell>{describeJournalSource(line.sourceType)}</TableCell>
                <TableCell>
                  <span className="font-mono text-[10px]">{line.accountCode}</span>{' '}
                  {line.accountName}
                </TableCell>
                <TableCell nowrap={false}>{line.memo ?? line.entryDescription}</TableCell>
                <TableCell align="numeric">
                  {line.debit === 0 ? (
                    <span className="text-text-muted">—</span>
                  ) : (
                    <span className="tabular-nums">
                      <Money amount={line.debit} />
                    </span>
                  )}
                </TableCell>
                <TableCell align="numeric">
                  {line.credit === 0 ? (
                    <span className="text-text-muted">—</span>
                  ) : (
                    <span className="tabular-nums">
                      <Money amount={line.credit} />
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))
          )}
        </tbody>
      </DataTable>
    </div>
  );
}
