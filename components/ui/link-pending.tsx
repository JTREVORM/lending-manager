'use client';

import { useLinkStatus } from 'next/link';

import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils/cn';

/**
 * Feedback for a navigation that has been asked for but has not arrived.
 *
 * ## Why this replaced a full-page spinner
 *
 * The application used to carry one `app/loading.tsx` at the root, which
 * showed a centred spinner for every route while its data was in flight. Two
 * things were wrong with that.
 *
 * The first is a correctness problem, and it is the reason this changed.
 * A route-level loading boundary makes Next.js flush the response shell
 * immediately, which commits the HTTP status before the page has read
 * anything. A page that then calls `notFound()` — asking for a loan that does
 * not exist, or one the reader may not see — had already sent `200 OK`. The
 * body said "not found" and the status said "here it is". Removing the
 * boundary lets `notFound()` set a real 404, which is what a monitor, a
 * cache, or anything else reading the status needs.
 *
 * The second is that blanking a working screen is worse feedback than
 * marking the thing that was pressed. A cashier who taps *Payments* wants to
 * know the tap landed; replacing the page they were reading with a spinner
 * tells them less, not more.
 *
 * So the feedback lives in the control. `useLinkStatus` is pending only for
 * the link that was actually followed, which is exactly the one the person is
 * waiting on. It must be rendered *inside* a `<Link>`; elsewhere it is never
 * pending and renders nothing.
 *
 * Nothing moves when it appears: the dot occupies its own fixed-size box, so
 * a row of navigation items does not reflow under the reader's finger.
 */
export function LinkPending({
  className,
  label = 'Opening',
}: {
  readonly className?: string;
  /** What is being opened, for a screen reader. */
  readonly label?: string;
}) {
  const { pending } = useLinkStatus();

  return (
    <span
      className={cn('inline-flex size-4 shrink-0 items-center justify-center', className)}
    >
      {pending ? <Spinner className="size-3 border" label={label} /> : null}
    </span>
  );
}
