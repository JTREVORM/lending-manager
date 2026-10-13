/**
 * The five views of Debt & Security.
 *
 * Pure, and in `lib/domain` rather than beside the tab strip that renders it,
 * because both ends of the URL need it: the client component writes the `view`
 * parameter and the server page reads it back to decide which register to
 * query.
 *
 * It lived in the component first, and the browser suite found the problem the
 * production build did not — a `'use client'` module's exports are a client
 * boundary, so the server page calling `isRecoveryView` compiled fine and then
 * failed at request time with "attempted to call it from the server". A plain
 * module has no boundary to cross.
 */

export const RECOVERY_VIEWS = [
  { value: '', label: 'Aging' },
  { value: 'risk', label: 'Risk monitoring' },
  { value: 'follow-ups', label: 'Follow-ups' },
  { value: 'promises', label: 'Promises to pay' },
  { value: 'security', label: 'Security held' },
] as const;

export type RecoveryView = (typeof RECOVERY_VIEWS)[number]['value'];

export function isRecoveryView(value: unknown): value is RecoveryView {
  return (
    typeof value === 'string' &&
    RECOVERY_VIEWS.some((view) => (view.value as string) === value)
  );
}
