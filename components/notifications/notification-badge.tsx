import { Bell } from 'lucide-react';

import { ROUTES } from '@/config/app';
import { badgeCount } from '@/lib/domain/notification';
import { cn } from '@/lib/utils/cn';

/**
 * The bell, in the header.
 *
 * A link, not a dropdown. The reference's own shell puts a count on an icon
 * and the icon opens a screen, and this follows it for a reason beyond
 * consistency: a panel that hangs off a header icon has to be a client
 * component with open state, has to trap focus, has to close on escape and on
 * an outside click, and has to decide what happens on a phone where it would
 * cover the page it is over. All of that to show five rows that the page
 * shows better.
 *
 * ## The badge is a number and a word
 *
 * Colour alone never carries meaning here, and a red dot carries none at all
 * to somebody who cannot see red or is reading in sunlight. The count is in
 * the badge, the state is in the accessible name — "Notifications, 3 unread,
 * 1 urgent" — and the tooltip says the same thing.
 */
export function NotificationBadge({
  unread,
  unreadUrgent,
  className,
  iconClassName,
}: {
  readonly unread: number;
  readonly unreadUrgent: number;
  readonly className?: string;
  readonly iconClassName?: string;
}) {
  const count = badgeCount(unread);

  const label =
    unread === 0
      ? 'Notifications, none unread'
      : unreadUrgent > 0
        ? `Notifications, ${String(unread)} unread, ${String(unreadUrgent)} urgent`
        : `Notifications, ${String(unread)} unread`;

  return (
    <a
      href={ROUTES.notifications}
      title={label}
      className={cn(
        'relative shrink-0 rounded-lg p-1.5 transition-colors',
        unreadUrgent > 0
          ? 'text-danger hover:bg-danger-surface'
          : 'text-text-muted hover:bg-surface-hover hover:text-text',
        className,
      )}
    >
      <Bell
        aria-hidden="true"
        className={cn('size-5', iconClassName)}
        strokeWidth={2.5}
      />

      {count === '' ? null : (
        <span
          aria-hidden="true"
          className={cn(
            // Top-right of the icon, and `tabular-nums` so "99+" and "3" sit
            // at the same optical weight rather than jittering the icon.
            'absolute -top-0.5 -right-0.5 min-w-4 rounded-full px-1',
            'text-[10px] leading-4 font-bold tabular-nums',
            unreadUrgent > 0 ? 'bg-danger text-white' : 'bg-accent text-accent-contrast',
          )}
        >
          {count}
        </span>
      )}

      {/* The whole state in words, for a screen reader and for the one in
          four people who cannot tell the two badge colours apart. */}
      <span className="sr-only">{label}</span>
    </a>
  );
}
