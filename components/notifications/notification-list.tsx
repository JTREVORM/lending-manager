'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useActionState, useTransition } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { RowLink } from '@/components/ui/row-link';
import { ROUTES } from '@/config/app';
import { formatRecordedDate } from '@/lib/domain/client';
import {
  NOTIFICATION_CATEGORY_LABELS,
  NOTIFICATION_GROUPS,
  NOTIFICATION_SEVERITIES,
  NOTIFICATION_SEVERITY_DESCRIPTIONS,
  NOTIFICATION_SEVERITY_LABELS,
  notificationHref,
  type NotificationSeverity,
} from '@/lib/domain/notification';
import { markNotificationsReadAction } from '@/lib/notifications/actions';
import { cn } from '@/lib/utils/cn';
import type { NotificationRow } from '@/lib/data/notifications';
import type { ActionResult } from '@/lib/auth/actions';

/**
 * The notification stream.
 *
 * ## Chronological, and it stays put
 *
 * Newest first, and the order does not change when something is read. A list
 * that re-sorted itself as rows were marked would move under the reader's
 * finger — they tap "read" on the third row and the fourth jumps up into the
 * space. Severity is shown on each row instead of sorting by it.
 *
 * ## Read is dismissal
 *
 * There is no separate dismiss, and nothing is hidden once read: a read row
 * stays in place, visibly quieter. Hiding it would mean a staff member who
 * cleared the bell on the bus cannot find what they cleared.
 */
const SEVERITY_TONES: Readonly<
  Record<NotificationSeverity, 'neutral' | 'info' | 'warning' | 'danger'>
> = {
  info: 'neutral',
  attention: 'warning',
  urgent: 'danger',
};

const LINK_ROUTES = {
  loans: ROUTES.loans,
  payments: ROUTES.payments,
  clients: ROUTES.clients,
  guarantors: ROUTES.guarantors,
  transfers: ROUTES.transfers,
  expenses: ROUTES.expenses,
  reconciliation: ROUTES.reconciliation,
  finance: ROUTES.finance,
} as const;

export function NotificationList({
  rows,
  page,
  hasMore,
  unread,
}: {
  readonly rows: readonly NotificationRow[];
  readonly page: number;
  readonly hasMore: boolean;
  readonly unread: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const [state, formAction, submitting] = useActionState<
    ActionResult | undefined,
    FormData
  >(markNotificationsReadAction, undefined);

  const group = params.get('group') ?? '';
  const severity = params.get('severity') ?? '';
  const unreadOnly = params.get('unread') === '1';

  const apply = (updates: Readonly<Record<string, string | null>>): void => {
    const next = new URLSearchParams(params.toString());

    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }

    next.delete('page');

    startTransition(() => {
      router.replace(`${pathname}?${next.toString()}`);
    });
  };

  const pageParams = (target: number): string => {
    const next = new URLSearchParams(params.toString());
    next.set('page', String(target));
    return next.toString();
  };

  return (
    <div className="min-w-0 space-y-4" aria-busy={isPending}>
      {/* --- Filters ----------------------------------------------------- */}
      <nav
        aria-label="Notification groups"
        className="chip-row border-border bg-surface rounded-lg border p-1.5 shadow-xs"
      >
        <button
          type="button"
          aria-current={group === '' ? 'page' : undefined}
          onClick={() => {
            apply({ group: null });
          }}
          className={cn(
            'chip',
            group === ''
              ? 'bg-accent text-accent-contrast shadow-xs'
              : 'text-text-muted hover:bg-surface-hover hover:text-text',
          )}
        >
          Everything
        </button>

        {NOTIFICATION_GROUPS.map((candidate) => (
          <button
            key={candidate.value}
            type="button"
            aria-current={group === candidate.value ? 'page' : undefined}
            onClick={() => {
              apply({ group: candidate.value });
            }}
            className={cn(
              'chip',
              group === candidate.value
                ? 'bg-accent text-accent-contrast shadow-xs'
                : 'text-text-muted hover:bg-surface-hover hover:text-text',
            )}
          >
            {candidate.label}
          </button>
        ))}
      </nav>

      <Card className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
          <div className="flex min-w-0 flex-wrap gap-3">
            <div className="min-w-0">
              <label
                htmlFor="notification-severity"
                className="text-text-muted block text-sm"
              >
                Severity
              </label>
              <select
                id="notification-severity"
                className="border-border bg-surface text-text focus-visible:outline-accent min-h-11 rounded-lg border px-3 focus-visible:outline-2 focus-visible:outline-offset-2"
                value={severity}
                onChange={(event) => {
                  apply({ severity: event.target.value });
                }}
              >
                <option value="">Any severity</option>
                {NOTIFICATION_SEVERITIES.map((value) => (
                  <option key={value} value={value}>
                    {NOTIFICATION_SEVERITY_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-end">
              <button
                type="button"
                onClick={() => {
                  apply({ unread: unreadOnly ? null : '1' });
                }}
                aria-pressed={unreadOnly}
                className={cn(
                  'min-h-11 rounded-lg border px-3 text-sm font-medium transition-colors',
                  unreadOnly
                    ? 'border-accent bg-accent text-accent-contrast'
                    : 'border-border text-text-muted hover:bg-surface-hover hover:text-text',
                )}
              >
                {unreadOnly ? 'Unread only' : 'Show unread only'}
              </button>
            </div>
          </div>

          {/*
            Submits no `notificationId`, which the action reads as "everything
            I can see" — not "everything on this page". Clearing the bell
            should clear the bell.
          */}
          {unread > 0 ? (
            <form action={formAction}>
              <Button type="submit" variant="secondary" disabled={submitting}>
                {submitting ? 'Marking…' : `Mark all ${String(unread)} read`}
              </Button>
            </form>
          ) : null}
        </div>

        {state?.message !== undefined ? (
          <Alert tone={state.ok ? 'success' : 'danger'} className="mt-3">
            {state.message}
          </Alert>
        ) : null}
      </Card>

      {rows.length === 0 ? (
        <Card>
          <p className="text-text-muted text-sm">
            {group === '' && severity === '' && !unreadOnly
              ? 'Nothing has been raised yet. Notifications appear here when something happens — a loan submitted, a payment reversed, a float running low. Nothing is raised for a loan merely becoming late, because that is a reading of the calendar rather than an event, and the overdue list already answers it.'
              : 'Nothing matches. That is not the same as nothing having happened — try clearing the filters.'}
          </p>
        </Card>
      ) : (
        <ul className="min-w-0 space-y-2">
          {rows.map((row) => (
            <li key={row.id}>
              <NotificationCard row={row} />
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-text-muted text-sm">Page {page}</p>
        <div className="flex gap-2">
          {page > 1 ? (
            <RowLink
              href={`${pathname}?${pageParams(page - 1)}`}
              className="text-brand-700 min-h-11 text-sm font-medium hover:underline"
            >
              Previous
            </RowLink>
          ) : null}
          {hasMore ? (
            <RowLink
              href={`${pathname}?${pageParams(page + 1)}`}
              className="text-brand-700 min-h-11 text-sm font-medium hover:underline"
            >
              Next
            </RowLink>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function NotificationCard({ row }: { readonly row: NotificationRow }) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    markNotificationsReadAction,
    undefined,
  );

  const href = notificationHref(row.entityType, row.entityId, LINK_ROUTES);

  return (
    <div
      className={cn(
        'border-border bg-surface min-w-0 rounded-lg border p-3',
        // An unread row carries a left edge in its severity colour. The badge
        // beside the title says the same thing in words, so the edge is
        // reinforcement rather than the message.
        !row.isRead && row.severity === 'urgent' && 'border-l-danger border-l-4',
        !row.isRead && row.severity === 'attention' && 'border-l-warning border-l-4',
        !row.isRead && row.severity === 'info' && 'border-l-accent border-l-4',
        // Read is the neutral edge: quiet, same 4px, so clearing a row does
        // not shift the list. Not `opacity-70`, for the reason the report
        // table records at length — dimming a container dims every child's
        // colour with it, and here it put the neutral "Read" badge below the
        // contrast floor. The row is already quieter in three other ways:
        // the uncoloured edge, the unbolded title, and the badge itself.
        row.isRead && 'border-l-border border-l-4',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p
            className={cn(
              'text-text break-words',
              row.isRead ? 'font-normal' : 'font-semibold',
            )}
          >
            {row.title}
          </p>
          <p className="text-text-muted mt-0.5 text-sm">
            {NOTIFICATION_CATEGORY_LABELS[row.category]} ·{' '}
            {formatRecordedDate(row.occurredAt)} · {row.actorLabel}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {row.isPersonal ? <Badge tone="info">For you</Badge> : null}
          <Badge
            tone={SEVERITY_TONES[row.severity]}
            title={NOTIFICATION_SEVERITY_DESCRIPTIONS[row.severity]}
          >
            {NOTIFICATION_SEVERITY_LABELS[row.severity]}
          </Badge>
          {row.isRead ? <Badge tone="neutral">Read</Badge> : null}
        </div>
      </div>

      {row.body === null ? null : (
        <p className="text-text mt-2 text-sm break-words">{row.body}</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-4">
        {href === null ? null : (
          <RowLink
            href={href}
            className="text-brand-700 focus-visible:outline-accent min-h-11 text-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Open it
          </RowLink>
        )}

        {row.isRead ? null : (
          <form action={formAction}>
            <input type="hidden" name="notificationId" value={row.id} />
            <button
              type="submit"
              disabled={pending}
              className="text-text-muted hover:text-text focus-visible:outline-accent min-h-11 text-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
            >
              {pending ? 'Marking…' : 'Mark read'}
            </button>
          </form>
        )}
      </div>

      {state?.ok === false ? (
        <Alert tone="danger" className="mt-2">
          {state.message}
        </Alert>
      ) : null}
    </div>
  );
}
