/**
 * The audit vocabulary and the shape of one recorded event.
 *
 * Separated from `lib/data/audit.ts` in Phase 9 because the audit *screen* is
 * a Client Component and the data module carries `import 'server-only'` — a
 * component that wanted the action labels was dragging the Supabase client
 * into the browser bundle to get them.
 *
 * Nothing here reaches a database. It is the words, the entity names and the
 * row shape: a dictionary, which both sides of the boundary may read.
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
