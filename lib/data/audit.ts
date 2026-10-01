import 'server-only';

import { mapDatabaseError } from '@/lib/db-errors';
import { logger } from '@/lib/logger';
import { createSupabaseServerClient } from '@/lib/supabase/server';

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

export async function listAuditEntries(limit = 100): Promise<readonly AuditEntry[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('audit_log')
    .select(
      'id, occurred_at, actor_label, action, entity_type, entity_id, old_values, new_values, metadata',
    )
    .order('occurred_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);

  if (error !== null) {
    logger.warn('Could not read the audit trail.', { code: error.code });
    throw mapDatabaseError(error, 'audit record');
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    occurredAt: row.occurred_at,
    actorLabel: row.actor_label,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    oldValues: row.old_values,
    newValues: row.new_values,
    metadata: row.metadata,
  }));
}

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
};
