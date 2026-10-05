import 'server-only';

// The vocabulary and the row shape live in `lib/domain/audit.ts`, so a Client
// Component can read them without pulling this server-only module into the
// browser bundle. Re-exported here because every existing caller imports them
// from this module.
export {
  AUDIT_ACTION_LABELS,
  AUDIT_ENTITY_TYPES,
  auditActions,
} from '@/lib/domain/audit';
export type { AuditEntry } from '@/lib/domain/audit';

import type { AuditEntry } from '@/lib/domain/audit';

import { mapDatabaseError } from '@/lib/db-errors';
import { logger } from '@/lib/logger';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { endOfBusinessDayExclusive, startOfBusinessDay } from '@/lib/domain/datetime';
import {
  pageWindow,
  resolvePageRequest,
  safeSearchTerm,
  takePage,
  type DateRange,
  type Paged,
} from '@/lib/domain/reporting';

/**
 * Reading the audit trail.
 *
 * Runs as the caller, so the `audit:view` policy decides whether anything
 * comes back at all. A caller without the capability receives an empty list
 * rather than an error, which is the correct shape — the rows are not theirs
 * to know about, including whether any exist.
 */

function toEntry(row: {
  id: number;
  occurred_at: string;
  actor_label: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  old_values: unknown;
  new_values: unknown;
  metadata: unknown;
}): AuditEntry {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    actorLabel: row.actor_label,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    oldValues: row.old_values,
    newValues: row.new_values,
    metadata: row.metadata,
  };
}

const AUDIT_COLUMNS =
  'id, occurred_at, actor_label, action, entity_type, entity_id, old_values, new_values, metadata';

export async function listAuditEntries(limit = 100): Promise<readonly AuditEntry[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('audit_log')
    .select(AUDIT_COLUMNS)
    .order('occurred_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);

  if (error !== null) {
    logger.warn('Could not read the audit trail.', { code: error.code });
    throw mapDatabaseError(error, 'audit record');
  }

  return (data ?? []).map(toEntry);
}

export interface AuditFilters {
  /** Business dates. Converted to an instant range in the business timezone. */
  readonly range?: DateRange;
  readonly action?: string;
  readonly entityType?: string;
  /** Matched against the actor's recorded label, not against a profile id. */
  readonly actor?: unknown;
  readonly page?: unknown;
  readonly pageSize?: unknown;
}

/**
 * The audit trail, filtered and paged.
 *
 * ## Why this is kept apart from the financial reports
 *
 * The audit trail records *who did what*; the reports record *what the money
 * did*. §78 asks for them to stay separate, and the reason is that a reader
 * who could total an audit listing would be tempted to reconcile it against
 * the ledger — two records of different things, kept for different reasons,
 * which will never agree. So the audit viewer has no money column, no total,
 * and no export. It lives on its own route behind `audit:view`.
 *
 * ## The filters are whitelisted like every other report's
 *
 * `action` and `entityType` are compared against the vocabularies below
 * before they reach a query, and the actor search is reduced to characters a
 * name contains. A value from a URL never becomes filter syntax.
 *
 * ## The date range is converted in the business timezone
 *
 * `occurred_at` is an instant. "Records from 4 October" means the Kampala day,
 * so the bounds are built from the configured zone rather than from UTC
 * midnight — otherwise a record at 00:30 Kampala would fall on the previous
 * day's report.
 */
export async function listAuditPage(
  filters: AuditFilters,
  timeZone: string,
): Promise<Paged<AuditEntry>> {
  const supabase = await createSupabaseServerClient();
  const request = resolvePageRequest(filters);
  const window = pageWindow(request);

  let query = supabase
    .from('audit_log')
    .select(AUDIT_COLUMNS)
    .order('occurred_at', { ascending: false })
    .order('id', { ascending: false })
    .range(window.from, window.to);

  if (filters.range !== undefined) {
    // The existing Phase 1 helpers, which sample the zone's offset near the
    // target instant. Writing a second date conversion here is the mistake
    // Phase 6 already recorded about having two date validators.
    query = query
      .gte('occurred_at', startOfBusinessDay(filters.range.from, timeZone).toISOString())
      .lt(
        'occurred_at',
        endOfBusinessDayExclusive(filters.range.to, timeZone).toISOString(),
      );
  }

  if (filters.action !== undefined) query = query.eq('action', filters.action);
  if (filters.entityType !== undefined) {
    query = query.eq('entity_type', filters.entityType);
  }

  const actor = safeSearchTerm(filters.actor);
  if (actor !== null) query = query.ilike('actor_label', `%${actor}%`);

  const { data, error } = await query;

  if (error !== null) {
    logger.warn('Could not read the audit trail.', { code: error.code });
    return { rows: [], page: request.page, pageSize: request.pageSize, hasMore: false };
  }

  return takePage((data ?? []).map(toEntry), request);
}
