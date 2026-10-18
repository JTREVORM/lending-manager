'use client';

import { RotateCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { cn } from '@/lib/utils/cn';

/**
 * "Try again" for a section whose data could not be read.
 *
 * ## Why a button and not a link
 *
 * A link to the same route is a navigation, and the App Router will serve the
 * cached Server Component payload for a route it believes it already has —
 * which is the one that failed. `router.refresh()` re-runs the Server
 * Components for the current route on the server and swaps in the new payload
 * without touching client state, which is exactly "ask the database again".
 *
 * ## Why it reports its own progress
 *
 * The failures this appears under are timeouts, so a retry can take seconds,
 * and a button that looks inert invites a second and third click — each one
 * another set of queries on a database that is already the constraint. It
 * disables itself and says so while the refresh is in flight.
 */
export function RetryButton({
  label = 'Try again',
  className,
}: {
  readonly label?: string;
  readonly className?: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [attempted, setAttempted] = useState(false);

  return (
    <button
      type="button"
      disabled={isPending}
      onClick={() => {
        setAttempted(true);
        startTransition(() => {
          router.refresh();
        });
      }}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border border-current/25 px-2.5 py-1',
        'text-[13px] font-semibold',
        'hover:bg-current/10 focus-visible:ring-2 focus-visible:ring-current/40 focus-visible:outline-none',
        'disabled:cursor-progress disabled:opacity-70',
        className,
      )}
      // The live region is on the label so a screen reader hears the change
      // rather than only seeing the button go quiet.
      aria-live="polite"
    >
      <RotateCw
        aria-hidden="true"
        className={cn('size-3.5', isPending && 'animate-spin')}
      />
      {isPending ? 'Reading again…' : attempted ? 'Try again' : label}
    </button>
  );
}
