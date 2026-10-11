import 'server-only';

import { logger } from '@/lib/logger';
import {
  categoriesInGroup,
  isNotificationCategory,
  isNotificationEntityType,
  isNotificationSeverity,
  type NotificationCategory,
  type NotificationEntityType,
  type NotificationGroup,
  type NotificationSeverity,
} from '@/lib/domain/notification';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Reading the notification stream.
 *
 * Both functions read a `security_invoker` view, so the policy decides which
 * rows come back and the per-reader read state is computed in the database
 * against `current_profile_id()`. Nothing here filters by audience: a reader
 * who could see a row by asking for it another way would see it here too, and
 * one who could not, cannot.
 *
 * ## The count is its own query, deliberately
 *
 * The bell renders on every page of the staff shell and needs one number. The
 * page needs twenty rows. Reading the feed to count it would pull the whole
 * stream into every layout render; `notification_summary` is an aggregate over
 * the same view and returns one row.
 */

export interface NotificationSummary {
  readonly total: number;
  readonly unread: number;
  readonly unreadUrgent: number;
  readonly unreadAttention: number;
  readonly newestUnreadAt: string | null;
}

const EMPTY_SUMMARY: NotificationSummary = {
  total: 0,
  unread: 0,
  unreadUrgent: 0,
  unreadAttention: 0,
  newestUnreadAt: null,
};

/**
 * What the bell shows.
 *
 * Falls back to zeroes rather than throwing: a header that cannot render
 * because a count failed takes the whole application down with it, and a bell
 * showing no badge is the same thing a bell with nothing in it shows. The
 * failure is logged, which is where it belongs.
 */
export async function getNotificationSummary(): Promise<NotificationSummary> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('notification_summary')
    .select('total, unread, unread_urgent, unread_attention, newest_unread_at')
    .maybeSingle();

  if (error !== null) {
    logger.warn('Could not read the notification summary.', { code: error.code });
    return EMPTY_SUMMARY;
  }

  if (data === null) return EMPTY_SUMMARY;

  return {
    total: Number(data.total ?? 0),
    unread: Number(data.unread ?? 0),
    unreadUrgent: Number(data.unread_urgent ?? 0),
    unreadAttention: Number(data.unread_attention ?? 0),
    newestUnreadAt: nullableText(data.newest_unread_at),
  };
}

export interface NotificationRow {
  readonly id: string;
  readonly category: NotificationCategory;
  readonly severity: NotificationSeverity;
  readonly title: string;
  readonly body: string | null;
  readonly entityType: NotificationEntityType;
  readonly entityId: string | null;
  readonly actorLabel: string;
  readonly occurredAt: string;
  /** Addressed to this reader by name rather than to their role. */
  readonly isPersonal: boolean;
  readonly isRead: boolean;
  readonly readAt: string | null;
}

const FEED_COLUMNS = `
  id, category, severity, title, body, entity_type, entity_id,
  actor_profile_id, actor_label, occurred_at, audience_permission,
  audience_profile_id, audience_branch_id, is_personal, is_read, read_at
`;

type Raw = Readonly<Record<string, unknown>>;

/**
 * A database value as text.
 *
 * The same helper the other data modules carry, for the same reason: every
 * column read here comes back as a string, so anything else is a mistake in
 * the query rather than a value to coerce — and `String(unknown)` on an object
 * renders `[object Object]` into a notification title.
 */
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return String(value);
  return '';
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function toRow(row: Raw): NotificationRow {
  // A category or severity this build does not know means the database and
  // the application have drifted. Logged and read as the mildest honest
  // value, so one unfamiliar row does not blank the whole bell.
  const category = isNotificationCategory(row.category) ? row.category : 'loan_decided';
  const severity = isNotificationSeverity(row.severity) ? row.severity : 'info';
  const entityType = isNotificationEntityType(row.entity_type) ? row.entity_type : 'loan';

  if (
    !isNotificationCategory(row.category) ||
    !isNotificationSeverity(row.severity) ||
    !isNotificationEntityType(row.entity_type)
  ) {
    logger.error('A notification carried a value this build does not know.', {
      category: text(row.category),
      severity: text(row.severity),
      entityType: text(row.entity_type),
    });
  }

  return {
    id: text(row.id),
    category,
    severity,
    title: text(row.title),
    body: nullableText(row.body),
    entityType,
    entityId: nullableText(row.entity_id),
    actorLabel: text(row.actor_label) === '' ? 'system' : text(row.actor_label),
    occurredAt: text(row.occurred_at),
    isPersonal: row.is_personal === true,
    isRead: row.is_read === true,
    readAt: nullableText(row.read_at),
  };
}

export interface NotificationFilter {
  readonly group?: NotificationGroup | null;
  readonly severity?: NotificationSeverity | null;
  /** Only the ones this reader has not read. */
  readonly unreadOnly?: boolean;
  readonly page?: number;
}

/**
 * The stream, newest first.
 *
 * Newest first rather than worst first, even though the page sorts severity
 * into view: a notification stream is a chronology, and a list that reordered
 * itself as things were read would move under the reader's finger. Severity is
 * carried on each row and shown there.
 */
export async function listNotifications(filter: NotificationFilter = {}): Promise<{
  readonly rows: readonly NotificationRow[];
  readonly page: number;
  readonly hasMore: boolean;
}> {
  const supabase = await createSupabaseServerClient();
  const page = Math.max(1, filter.page ?? 1);
  const size = 25;
  const from = (page - 1) * size;

  let query = supabase
    .from('notification_feed')
    .select(FEED_COLUMNS)
    .order('occurred_at', { ascending: false })
    .order('id', { ascending: false })
    .range(from, from + size);

  if (filter.group != null) {
    // Filtered on the real column rather than on a label, so the chip and the
    // query cannot disagree about what a group contains.
    query = query.in('category', [...categoriesInGroup(filter.group)]);
  }

  if (filter.severity != null) query = query.eq('severity', filter.severity);
  if (filter.unreadOnly === true) query = query.eq('is_read', false);

  const { data, error } = await query;

  if (error !== null) {
    logger.warn('Could not read the notification feed.', { code: error.code });
    return { rows: [], page, hasMore: false };
  }

  const rows = data ?? [];

  // One row past the page answers "is there a next page" without a count
  // query, the way every other register here pages.
  return {
    rows: rows.slice(0, size).map(toRow),
    page,
    hasMore: rows.length > size,
  };
}

/**
 * The few most recent unread, for the bell's dropdown.
 *
 * Five, because a panel hanging off a header icon that needs scrolling is a
 * page in disguise — and there is a page.
 */
export async function listRecentUnread(limit = 5): Promise<readonly NotificationRow[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('notification_feed')
    .select(FEED_COLUMNS)
    .eq('is_read', false)
    .order('occurred_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);

  if (error !== null) {
    logger.warn('Could not read the recent notifications.', { code: error.code });
    return [];
  }

  return (data ?? []).map(toRow);
}
