import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { DataTable, TableCell, TableHead, TableRow } from '@/components/ui/data-table';
import { Money } from '@/components/ui/money';
import { EmptyTableRow } from '@/components/ui/states';
import { ROUTES } from '@/config/app';
import {
  agentAccountName,
  agentAccountNoun,
  type AgencyAgentAccountRow,
  type AgencyProviderCategory,
} from '@/lib/domain/agency';

/**
 * A line's state as a chip.
 *
 * Three states and three readings, because they mean three different things to
 * somebody at a counter: trading, stopped but still holding money, finished.
 * A closed account keeps its history and its page — what it does not do is
 * take new business.
 */
export function AgentAccountStatusBadge({
  status,
}: {
  readonly status: 'active' | 'suspended' | 'closed';
}) {
  if (status === 'active') return <Badge tone="success">Active</Badge>;
  if (status === 'suspended') return <Badge tone="warning">Suspended</Badge>;
  return <Badge tone="neutral">Closed</Badge>;
}

/**
 * One table of agent accounts or agent lines.
 *
 * ## Why one component for banks and Mobile Money
 *
 * A bank calls it an agent account and prints an agent number on its
 * statement; MTN and Airtel call it a line and it has a phone number. In the
 * database they are one row of `agency_provider_float_accounts` with one
 * ledger account of its own, and every figure below comes from one view for
 * both. Two tables would be two sets of figures that could disagree with each
 * other and with the ledger, which is the thing the client's §5.1 asks us not
 * to build: "reusable provider-driven components rather than copying the same
 * business logic into separate MTN and Airtel implementations."
 *
 * The one thing that does differ is the noun, and `agentAccountNoun()` decides
 * it from the provider's category so an empty state does not tell a bank it
 * has no "lines".
 *
 * ## Why the identifier column is masked
 *
 * `lineMsisdnMasked` is masked in the view it comes from and nowhere
 * unmasked. A register any reader with `agency:reports` may open has no
 * business handing out a complete agent MSISDN, and `+256 77 *** 4567` is what
 * a supervisor reads back to confirm they are looking at the right line
 * anyway.
 */
export function AgentAccountTable({
  rows,
  category,
  caption,
  showProvider = true,
  emptyMessage,
}: {
  readonly rows: readonly AgencyAgentAccountRow[];
  /** Decides the noun. Pass the category the page is about. */
  readonly category: AgencyProviderCategory;
  readonly caption: string;
  /** Hidden on a single provider's own page, where every row is that provider. */
  readonly showProvider?: boolean;
  readonly emptyMessage?: string;
}) {
  const noun = agentAccountNoun(category);

  return (
    <DataTable caption={caption}>
      <thead>
        <TableRow>
          {showProvider ? <TableHead>Provider</TableHead> : null}
          <TableHead>{noun.singular === 'agent line' ? 'Line' : 'Account'}</TableHead>
          <TableHead>Identifier</TableHead>
          <TableHead>Branch</TableHead>
          <TableHead align="numeric">Float</TableHead>
          <TableHead align="numeric">Today in</TableHead>
          <TableHead align="numeric">Today out</TableHead>
          <TableHead align="numeric">Commission today</TableHead>
          <TableHead align="numeric">Commission owed</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <EmptyTableRow colSpan={showProvider ? 10 : 9}>
            {emptyMessage ?? `No ${noun.singular} is registered yet.`}
          </EmptyTableRow>
        ) : (
          rows.map((row) => (
            <TableRow key={row.floatAccountId}>
              {showProvider ? <TableCell>{row.providerName}</TableCell> : null}
              <TableCell>
                <Link
                  href={`${ROUTES.agencyAccounts}/${row.floatAccountId}`}
                  className="text-link font-semibold hover:underline"
                >
                  {agentAccountName(row)}
                </Link>
              </TableCell>
              <TableCell>
                {/* The provider's own code is what a statement is matched on,
                    so it leads; the masked number is what a person recognises
                    the line by. Whichever exists. */}
                <span className="text-text-muted text-xs">
                  {row.agentCode ?? row.lineMsisdnMasked ?? `Till ${row.tillName}`}
                </span>
              </TableCell>
              <TableCell>{row.branchCode}</TableCell>
              <TableCell align="numeric">
                <Money amount={row.floatBalance} />
              </TableCell>
              <TableCell align="numeric">
                <Money amount={row.depositValueToday} />
              </TableCell>
              <TableCell align="numeric">
                <Money amount={row.withdrawalValueToday} />
              </TableCell>
              <TableCell align="numeric">
                <Money amount={row.commissionToday} />
              </TableCell>
              <TableCell align="numeric">
                <Money amount={row.commissionOutstanding} />
              </TableCell>
              <TableCell>
                <AgentAccountStatusBadge status={row.lineStatus} />
              </TableCell>
            </TableRow>
          ))
        )}
      </tbody>
    </DataTable>
  );
}
