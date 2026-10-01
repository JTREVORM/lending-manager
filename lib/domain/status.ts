/**
 * Record lifecycle vocabularies.
 *
 * ## Deletion policy
 *
 * This is a financial system, so **records are not deleted**. Two mechanisms
 * replace deletion, and which one applies depends on whether the record is
 * part of the financial ledger:
 *
 *   - **Reference and identity records** (profiles, and later clients and
 *     guarantors) are *archived*: `status` moves to `archived`, `archived_at`
 *     is stamped, and the row stops appearing in working lists while every
 *     historical reference to it stays intact.
 *
 *   - **Financial records** (loans, repayment schedules, payments, penalties —
 *     all Phase 3) are *immutable once posted*. A mistake is corrected by
 *     writing a compensating record (a reversal) that points at the original,
 *     never by editing or removing it. A reversed payment therefore leaves two
 *     rows: the payment and its reversal. That is what makes a receipt
 *     trustworthy and a balance reconstructable.
 *
 * Nothing in Phase 1 issues a `DELETE`. The audit table goes further and
 * blocks `UPDATE` and `DELETE` at the database level.
 *
 * See docs/DECISIONS.md (ADR-006).
 */

/**
 * Lifecycle of a person's record in the system.
 *
 *   - `active`    — in good standing, appears everywhere.
 *   - `inactive`  — temporarily not transacting; still fully visible.
 *   - `suspended` — blocked from transacting by a decision of the business.
 *   - `archived`  — retired from working lists; history preserved. The nearest
 *                   thing to a delete that this system permits.
 */
export const PROFILE_STATUSES = ['active', 'inactive', 'suspended', 'archived'] as const;
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];

/** Statuses whose holder may sign in and transact. */
export const TRANSACTABLE_PROFILE_STATUSES: readonly ProfileStatus[] = ['active'];

export function isProfileStatus(value: unknown): value is ProfileStatus {
  return (
    typeof value === 'string' && (PROFILE_STATUSES as readonly string[]).includes(value)
  );
}

/** Does this status permit signing in and transacting? */
export function canTransact(status: ProfileStatus): boolean {
  return TRANSACTABLE_PROFILE_STATUSES.includes(status);
}

/** Should records with this status be hidden from default working lists? */
export function isArchived(status: ProfileStatus): boolean {
  return status === 'archived';
}

/** Human labels for the UI. Kept beside the vocabulary so they cannot drift. */
export const PROFILE_STATUS_LABELS: Readonly<Record<ProfileStatus, string>> = {
  active: 'Active',
  inactive: 'Inactive',
  suspended: 'Suspended',
  archived: 'Archived',
} as const;
