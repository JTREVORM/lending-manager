/**
 * Client and guarantor domain vocabulary.
 *
 * The status list and its meanings live here rather than in a component or a
 * validation schema, because three layers need the same answer: the database
 * constrains the column to these values, the forms offer them, and the badges
 * colour them. One list, one set of meanings.
 */

/**
 * A client's lifecycle.
 *
 * The meanings are business meanings, and they are not interchangeable:
 *
 *   - `active` — borrowing normally. The only status from which Phase 4 will
 *     permit a new loan.
 *   - `inactive` — not currently borrowing, retained in the database. The
 *     ordinary resting state for a client who has repaid and gone quiet. No
 *     judgement is implied and no reason is required.
 *   - `suspended` — temporarily restricted while something is resolved: a
 *     disputed payment, an unreachable phone, a pending document. Requires a
 *     reason, because a restriction nobody can explain cannot be lifted with
 *     any confidence.
 *   - `blacklisted` — the business has deliberately decided not to lend to
 *     this person again. Requires a reason, and requires the Owner's
 *     capability: it is a standing commercial judgement rather than an
 *     operational state.
 *   - `archived` — the record is retained but out of use. This is what
 *     replaces deletion; nothing in the application deletes a client.
 */
import {
  formatBusinessDate,
  instantToBusinessDate,
  isBusinessDate,
} from '@/lib/domain/datetime';

export const CLIENT_STATUSES = [
  'active',
  'inactive',
  'suspended',
  'blacklisted',
  'archived',
] as const;

export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export function isClientStatus(value: unknown): value is ClientStatus {
  return (
    typeof value === 'string' && (CLIENT_STATUSES as readonly string[]).includes(value)
  );
}

export const CLIENT_STATUS_LABELS: Readonly<Record<ClientStatus, string>> = {
  active: 'Active',
  inactive: 'Inactive',
  suspended: 'Suspended',
  blacklisted: 'Blacklisted',
  archived: 'Archived',
};

/** One line explaining what the status means, shown beside the control. */
export const CLIENT_STATUS_DESCRIPTIONS: Readonly<Record<ClientStatus, string>> = {
  active: 'Borrowing normally.',
  inactive: 'Not currently borrowing. Kept on record.',
  suspended: 'Temporarily restricted while something is resolved.',
  blacklisted: 'Deliberately refused future lending.',
  archived: 'Retained but out of use.',
};

/**
 * Statuses that require a written reason.
 *
 * Enforced in the database by `clients_restricted_status_has_reason`; repeated
 * here so the form can ask for one rather than letting the insert fail.
 */
export const CLIENT_STATUSES_REQUIRING_REASON: readonly ClientStatus[] = [
  'suspended',
  'blacklisted',
];

export function statusRequiresReason(status: ClientStatus): boolean {
  return CLIENT_STATUSES_REQUIRING_REASON.includes(status);
}

/**
 * May this client take a loan?
 *
 * Phase 4 will own the eligibility rule in full — it has to consider existing
 * loans, which do not exist yet. This is the part that is already decidable
 * and will not change: only an active client can borrow.
 */
export function canBorrow(status: ClientStatus): boolean {
  return status === 'active';
}

// ---------------------------------------------------------------------------
// Sex
// ---------------------------------------------------------------------------

/**
 * Recorded because the business's paper forms record it and because a
 * Ugandan NIN encodes it, so a mismatch is a useful signal that a number was
 * mistyped. Two values, matching the national identity document.
 */
export const SEXES = ['female', 'male'] as const;
export type Sex = (typeof SEXES)[number];

export function isSex(value: unknown): value is Sex {
  return typeof value === 'string' && (SEXES as readonly string[]).includes(value);
}

export const SEX_LABELS: Readonly<Record<Sex, string>> = {
  female: 'Female',
  male: 'Male',
};

// ---------------------------------------------------------------------------
// Remarks
// ---------------------------------------------------------------------------

/**
 * Remark categories.
 *
 * Closed and short on purpose: a free-text category becomes thirty spellings
 * of "late payment" and stops being groupable. `retraction` is not offered in
 * the compose form — it is set by the retract action.
 */
export const REMARK_CATEGORIES = [
  'general',
  'payment_concern',
  'contact',
  'business',
  'retraction',
] as const;

export type RemarkCategory = (typeof REMARK_CATEGORIES)[number];

export function isRemarkCategory(value: unknown): value is RemarkCategory {
  return (
    typeof value === 'string' && (REMARK_CATEGORIES as readonly string[]).includes(value)
  );
}

/** Categories a person may choose when writing a remark. */
export const COMPOSABLE_REMARK_CATEGORIES: readonly RemarkCategory[] = [
  'general',
  'payment_concern',
  'contact',
  'business',
];

export const REMARK_CATEGORY_LABELS: Readonly<Record<RemarkCategory, string>> = {
  general: 'General',
  payment_concern: 'Payment concern',
  contact: 'Contact detail',
  business: 'Business',
  retraction: 'Retraction',
};

// ---------------------------------------------------------------------------
// National Identification Number
// ---------------------------------------------------------------------------

/**
 * Uganda's NIN: 14 characters — `CM` or `CF` then twelve alphanumerics.
 *
 * Shape only. The check-digit algorithm is not published, so a stricter
 * validation would be guesswork that rejects valid cards. A wrong length or a
 * wrong prefix, on the other hand, is a transcription error worth catching at
 * the counter while the card is still in the person's hand.
 */
export const NIN_PATTERN = /^C[MF][0-9A-Z]{12}$/;

export function isNin(value: unknown): value is string {
  return typeof value === 'string' && NIN_PATTERN.test(value);
}

/**
 * Normalise a typed NIN: trim, strip internal spaces, uppercase.
 *
 * Cards are read aloud and typed with spaces in them. This is formatting, not
 * identity data correction — the characters themselves are never altered.
 */
export function normalizeNin(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

/**
 * A NIN reduced for display to somebody who should not see all of it.
 *
 * Mirrors `public.mask_nin`, which does the same for audit metadata. The last
 * three characters are enough to confirm a number against a card in hand
 * without the screen itself becoming a copy of it.
 */
export function maskNin(nin: string): string {
  if (nin.length <= 3) return '***';
  return `***${nin.slice(-3)}`;
}

/**
 * Does this NIN agree with the recorded sex?
 *
 * `CF…` is female, `CM…` is male. A disagreement is reported as a warning
 * rather than an error: the business works from the card, and a mismatch means
 * somebody mistyped one of the two fields — but which one is for a person to
 * decide, not for a form to guess.
 */
export function ninAgreesWithSex(nin: string, sex: Sex): boolean {
  const marker = nin.charAt(1).toUpperCase();
  return (sex === 'female' && marker === 'F') || (sex === 'male' && marker === 'M');
}

// ---------------------------------------------------------------------------
// Age
// ---------------------------------------------------------------------------

/** The borrowing age. Enforced in the database too. */
export const MINIMUM_CLIENT_AGE = 18;

/**
 * Completed years between a date of birth and a reference date.
 *
 * Takes the reference date explicitly rather than reading the clock, so that
 * the function is pure and a test can ask about a birthday tomorrow without
 * waiting for it.
 */
export function ageOn(dateOfBirth: Date, on: Date): number {
  let age = on.getUTCFullYear() - dateOfBirth.getUTCFullYear();

  const monthDelta = on.getUTCMonth() - dateOfBirth.getUTCMonth();
  const beforeBirthday =
    monthDelta < 0 || (monthDelta === 0 && on.getUTCDate() < dateOfBirth.getUTCDate());

  if (beforeBirthday) age -= 1;

  return age;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * A stored instant, shown as a Kampala calendar date.
 *
 * `registered_at` is a `timestamptz`, so rendering it needs a timezone or the
 * server and the browser disagree about which day it was. The business
 * timezone is applied before formatting, never the viewer's.
 *
 * Invalid input renders as an em dash rather than throwing: a malformed
 * timestamp is a data problem worth seeing on the page, not a reason to fail
 * the whole render of a client's record.
 */
export function formatRecordedDate(iso: string): string {
  const instant = new Date(iso);

  if (Number.isNaN(instant.getTime())) return '—';

  return formatBusinessDate(instantToBusinessDate(instant));
}

/**
 * A stored calendar date (`date_of_birth`), shown as written.
 *
 * No timezone conversion: a date of birth is a calendar date, not an instant,
 * and shifting it by three hours would show the wrong day for anyone born
 * before 03:00.
 */
export function formatCalendarDate(value: string): string {
  if (!isBusinessDate(value)) return '—';

  return formatBusinessDate(value);
}
