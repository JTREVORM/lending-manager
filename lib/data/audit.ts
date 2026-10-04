import 'server-only';

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

export interface AuditEntry {
  readonly id: number;
  readonly occurredAt: string;
  readonly actorLabel: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly oldValues: unknown;
  readonly newValues: unknown;
  readonly metadata: unknown;
}

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

/**
 * Every action the triggers record, as a filter vocabulary.
 *
 * Generated from the labels below rather than maintained twice: an action with
 * no label would be invisible in the filter, and one in the filter with no
 * label would read as a raw identifier.
 */
export function auditActions(): readonly string[] {
  return Object.keys(AUDIT_ACTION_LABELS).sort();
}

/** The entity types the trail records, for the entity filter. */
export const AUDIT_ENTITY_TYPES = [
  'profile',
  'user_role',
  'business_settings',
  'company_settings',
  'client',
  'client_identity',
  'client_guarantor',
  'client_remark',
  'guarantor',
  'guarantor_identity',
  'loan',
  'loan_schedule',
  'loan_payment',
  'payment_allocation',
  'loan_penalty',
  'auth',
] as const;

/** Human wording for the action vocabulary, so the trail reads as sentences. */
export const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  'user.created': 'Created a user',
  'user.updated': 'Updated a user',
  'user.status_changed': 'Changed an account status',
  'user.password_reset': 'Issued a temporary password',
  'user.role_granted': 'Granted a role',
  'user.role_revoked': 'Revoked a role',
  'settings.updated': 'Changed settings',
  'auth.signed_in': 'Signed in',
  'auth.signed_out': 'Signed out',
  'auth.password_changed': 'Changed their password',
  'auth.sign_in_denied': 'Was refused sign-in',

  // Phase 3 onwards. The trail grew with every phase; the labels did not, so
  // until Phase 8 the viewer showed raw identifiers for most of what it holds.
  'client.created': 'Registered a client',
  'client.updated': 'Updated a client',
  'client.status_changed': "Changed a client's status",
  'client.identity_recorded': "Recorded a client's identification",
  'client.identity_updated': "Updated a client's identification",
  'client.photo_changed': "Changed a client's photograph",
  'client.document_changed': "Changed a client's document",
  'client.auth_linked': 'Linked a client to a login',
  'client.auth_unlinked': 'Unlinked a client from a login',
  'client.remark_added': 'Added an internal note',
  'guarantor.created': 'Registered a guarantor',
  'guarantor.updated': 'Updated a guarantor',
  'guarantor.identity_recorded': "Recorded a guarantor's identification",
  'guarantor.identity_updated': "Updated a guarantor's identification",
  'guarantor.photo_changed': "Changed a guarantor's photograph",
  'guarantor.linked': 'Attached a guarantor to a client',
  'guarantor.link_updated': 'Changed a guarantor attachment',
  'guarantor.unlinked': 'Detached a guarantor from a client',
  'loan.created': 'Started a loan',
  'loan.updated': 'Updated a loan draft',
  'loan.submitted': 'Submitted a loan for approval',
  'loan.approved': 'Approved a loan',
  'loan.returned_to_draft': 'Returned a loan for correction',
  'loan.terms_locked': "Locked a loan's terms",
  'loan.snapshot_created': 'Captured a loan snapshot',
  'loan.disbursed': 'Paid out a loan',
  'loan.schedule_generated': 'Generated a repayment schedule',
  'loan.cancelled': 'Cancelled a loan',
  'loan.cleared': 'Settled a loan',
  'loan.reopened': 'Reopened a settled loan',
  'loan.penalty_applied': 'Applied a late-payment charge',
  'payment.posted': 'Recorded a payment',
  'payment.allocated': 'Applied a payment to a loan',
  'payment.reversed': 'Reversed a payment',
};
