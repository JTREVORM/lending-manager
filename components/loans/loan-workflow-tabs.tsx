'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

import { cn } from '@/lib/utils/cn';
import {
  LOAN_WORKFLOW_LABELS,
  LOAN_WORKFLOW_STAGES,
  type LoanWorkflowStage,
} from '@/lib/domain/loan';

/**
 * The loan module's views, as one strip.
 *
 * Eleven stages plus "All loans", each a filter on the same register. They are
 * links in the URL rather than component state, so a view can be reloaded,
 * bookmarked or sent to a colleague, and the filtering happens server-side —
 * which means Row Level Security applies to the filtered query rather than to
 * a full list trimmed in the browser.
 *
 * ## Why the strip scrolls rather than wraps
 *
 * Twelve chips do not fit across 320px, and a wrapping flex row turns
 * "Awaiting disbursement" into vertical letters. The same `chip-row` the
 * detail pages use: one line, always, scrolling horizontally when it has to.
 *
 * ## The counts are not here
 *
 * A badge per stage would need twelve aggregate queries on every render of a
 * screen whose job is to show twenty rows. The stage a person is on reports
 * its own count under the filters; the others do not claim one.
 */
export function LoanWorkflowTabs({ stage }: { readonly stage: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  function go(next: string): void {
    const params = new URLSearchParams(searchParams.toString());

    if (next === '') params.delete('stage');
    else params.set('stage', next);

    // Any change of view returns to the first page: staying on page four of a
    // different result set shows an empty screen for no visible reason.
    params.delete('page');

    startTransition(() => {
      router.replace(`${pathname}?${params.toString()}`);
    });
  }

  const tabs: readonly { readonly value: string; readonly label: string }[] = [
    { value: '', label: 'All loans' },
    ...LOAN_WORKFLOW_STAGES.map((value: LoanWorkflowStage) => ({
      value,
      label: LOAN_WORKFLOW_LABELS[value],
    })),
  ];

  return (
    <nav
      aria-label="Loan views"
      aria-busy={isPending}
      className="chip-row border-border bg-surface rounded-lg border p-1.5 shadow-xs"
    >
      {tabs.map((tab) => {
        const isActive = tab.value === stage;

        return (
          <button
            key={tab.value === '' ? 'all' : tab.value}
            type="button"
            aria-current={isActive ? 'page' : undefined}
            onClick={() => {
              go(tab.value);
            }}
            className={cn(
              'chip',
              isActive
                ? 'bg-accent text-accent-contrast shadow-xs'
                : 'text-text-muted hover:bg-surface-hover hover:text-text',
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}
