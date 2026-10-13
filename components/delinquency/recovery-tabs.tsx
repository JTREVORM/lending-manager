'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

import { RECOVERY_VIEWS } from '@/lib/domain/debt-views';
import { cn } from '@/lib/utils/cn';

/**
 * The five views of Debt & Security, as one strip.
 *
 * Links in the URL rather than component state, so a view can be reloaded,
 * bookmarked or sent to a colleague — and so that only the view being read is
 * queried. A tabbed component holding all five would mean five result sets
 * fetched for a screen showing one of them, which on this page includes a
 * portfolio aggregate and two registers.
 *
 * The vocabulary itself is in `lib/domain/debt-views.ts`, because the server
 * page reads the same parameter back and a `'use client'` module's exports
 * cannot be called from the server.
 */
export function RecoveryTabs({ view }: { readonly view: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  function go(next: string): void {
    const params = new URLSearchParams(searchParams.toString());

    if (next === '') params.delete('view');
    else params.set('view', next);

    // A view change starts at the top of the new list. Carrying a bucket
    // filter into the promise register would filter nothing and look broken.
    params.delete('page');
    params.delete('bucket');

    startTransition(() => {
      router.replace(`${pathname}?${params.toString()}`);
    });
  }

  return (
    <nav
      aria-label="Debt and security views"
      aria-busy={isPending}
      className="chip-row border-border bg-surface rounded-lg border p-1.5 shadow-xs"
    >
      {RECOVERY_VIEWS.map((tab) => {
        const isActive = tab.value === view;

        return (
          <button
            key={tab.value === '' ? 'aging' : tab.value}
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
