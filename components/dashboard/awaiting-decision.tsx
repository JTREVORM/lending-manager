import { ArrowLeftRight, ClipboardCheck, Receipt } from 'lucide-react';

import { StatCard, StatGrid } from '@/components/reports/stat-card';
import { RowLink } from '@/components/ui/row-link';
import { ROUTES } from '@/config/app';
import type { PendingApprovals } from '@/lib/data/dashboard';

/**
 * Money movements waiting for somebody to decide.
 *
 * ## Why counts and not rows
 *
 * The decision is made on the screen that shows the movement in full — who
 * raised it, between which accounts, for how much, and why. A dashboard that
 * listed the rows would be a worse copy of that screen, and the approver would
 * still have to leave it to act. So this says how many and where, and the
 * number is a link.
 *
 * ## Each count is read only by somebody who could act on it
 *
 * A Manager who cannot approve an expense is not shown a number they can do
 * nothing about — and the query is not run either, so the figure is absent
 * from the page rather than hidden in its markup. That is the same rule the
 * rest of this dashboard follows, and the reason it is a rule: a presentation
 * decision becomes a leak the moment somebody reads the HTML.
 *
 * ## Nothing here is new information
 *
 * Phase 15 already raises a notification when a transfer, an expense or a
 * reconciliation starts waiting. This is the same fact as a standing count
 * rather than as an event — a bell tells you something happened, and a count
 * tells you something is still undone, which is the question somebody opening
 * a dashboard is actually asking.
 */
export function AwaitingDecision({ pending }: { readonly pending: PendingApprovals }) {
  const tiles = [
    {
      key: 'transfers',
      label: 'Transfers awaiting approval',
      count: pending.transfers,
      href: ROUTES.transfers,
      icon: ArrowLeftRight,
      definition:
        'Money moved between the business’s own accounts, over the threshold at which a second person decides. A transfer is not income or expense; it posts to the ledger only once approved.',
    },
    {
      key: 'expenses',
      label: 'Expenses awaiting approval',
      count: pending.expenses,
      href: ROUTES.expenses,
      icon: Receipt,
      definition:
        'Business costs raised and waiting for a decision. Nothing posts to the ledger until one is approved.',
    },
    {
      key: 'reconciliations',
      label: 'Counts awaiting review',
      count: pending.reconciliations,
      href: ROUTES.reconciliation,
      icon: ClipboardCheck,
      definition:
        'A cash count that has been submitted and is waiting to be reviewed. A count that did not balance is money unaccounted for, which is the most serious thing this system can report.',
    },
  ].filter((tile) => tile.count > 0);

  // Nothing waiting is worth saying once, quietly, rather than as three
  // zeroes: a row of empty tiles reads as a section that failed to load.
  if (tiles.length === 0) {
    return (
      <section aria-labelledby="awaiting-heading" className="min-w-0 space-y-3">
        <h2 id="awaiting-heading" className="text-base">
          Awaiting a decision
        </h2>
        <p className="text-text-muted text-sm">
          Nothing is waiting. Every transfer, expense and cash count that needed a
          decision has had one.
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="awaiting-heading" className="min-w-0 space-y-3">
      <h2 id="awaiting-heading" className="text-base">
        Awaiting a decision
      </h2>

      <StatGrid>
        {tiles.map((tile) => (
          <StatCard
            key={tile.key}
            label={tile.label}
            value={String(tile.count)}
            secondary={
              <RowLink
                href={tile.href}
                className="text-brand-700 underline-offset-2 hover:underline"
              >
                Review {tile.count === 1 ? 'it' : 'them'}
              </RowLink>
            }
            definition={tile.definition}
            icon={tile.icon}
            tone="warning"
          />
        ))}
      </StatGrid>
    </section>
  );
}
