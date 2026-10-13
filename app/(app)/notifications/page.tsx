import { Bell } from 'lucide-react';

import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { NotificationList } from '@/components/notifications/notification-list';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { getNotificationSummary, listNotifications } from '@/lib/data/notifications';
import { notificationSearchSchema } from '@/lib/validation/notification';

export const metadata = { title: 'Notifications' };

/**
 * The notification stream.
 *
 * ## What is here, and what is deliberately not
 *
 * Everything the reader is entitled to see, newest first, with the severity on
 * each row and a deep link to the thing it is about. What is not here is any
 * notification about a loan merely *becoming* late: that is a reading of the
 * calendar rather than an event, the overdue list and the aging register
 * answer it correctly on every read, and a stored row claiming it would be
 * right on Tuesday and wrong on Wednesday with nothing to correct it.
 *
 * ## Two reads, not one
 *
 * The summary is read alongside the page because the "mark all read" control
 * needs to say how many there are, and the count comes from an aggregate over
 * the same view rather than from counting the page — which would say "mark all
 * 25 read" on a stream of two hundred.
 */
export default async function NotificationsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await guardPermission(ROUTES.notifications, 'notifications:view');

  const params = await searchParams;

  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  // An unrecognised filter falls back to the unfiltered stream rather than
  // erroring: a hand-edited query string should show the notifications.
  const parsed = notificationSearchSchema.safeParse({
    group: single('group'),
    severity: single('severity'),
    unread: single('unread'),
    page: single('page'),
  });

  const filter = parsed.success
    ? parsed.data
    : { group: null, severity: null, unread: false, page: 1 as const };

  const [feed, summary] = await Promise.all([
    listNotifications({
      group: filter.group,
      severity: filter.severity,
      unreadOnly: filter.unread,
      page: filter.page,
    }),
    getNotificationSummary(),
  ]);

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Operations"
        icon={Bell}
        title="Notifications"
        description="What has happened that somebody should know about, newest first."
      />

      <Card className="min-w-0">
        <dl className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="min-w-0">
            <dt className="text-text-muted text-sm">Unread</dt>
            <dd className="text-text text-xl font-semibold tabular-nums">
              {summary.unread}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-text-muted text-sm">Urgent</dt>
            <dd className="text-text text-xl font-semibold tabular-nums">
              {summary.unreadUrgent}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-text-muted text-sm">Needs attention</dt>
            <dd className="text-text text-xl font-semibold tabular-nums">
              {summary.unreadAttention}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-text-muted text-sm">In total</dt>
            <dd className="text-text text-xl font-semibold tabular-nums">
              {summary.total}
            </dd>
          </div>
        </dl>

        <p className="text-text-muted mt-4 text-sm">
          Read is per person: marking one read here clears it from your bell and nobody
          else&apos;s. What you can see is decided by what you may do — a reversal is
          shown to whoever may reverse a payment, a cash variance to whoever may approve a
          count.
        </p>
      </Card>

      <NotificationList
        rows={feed.rows}
        page={feed.page}
        hasMore={feed.hasMore}
        unread={summary.unread}
      />
    </div>
  );
}
