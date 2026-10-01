/**
 * Ugandan phone number normalisation.
 *
 * A phone number is the primary way this business identifies a client — many
 * clients have no email address, and it is the number a cashier reads back
 * over the counter. It is therefore a `UNIQUE` column, which only works if
 * every write stores the *same* number in the *same* shape. Staff will type
 * `0772 123 456`, `+256772123456`, `256-772-123456` and `772123456` for one
 * person, so all of those must converge.
 *
 * ## Canonical form
 *
 * E.164 without separators: `+256` followed by exactly nine digits, e.g.
 * `+256772123456`. The database enforces the shape with a `CHECK` constraint,
 * so a row that bypassed this module still cannot be stored malformed.
 *
 * Mobile-money payments (MTN and Airtel, a later phase) are addressed by this
 * same number, which is another reason the stored form must be exact.
 */

export class PhoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhoneError';
  }
}

/** Uganda's E.164 country calling code. */
export const UGANDA_COUNTRY_CODE = '256' as const;

/** Significant digits in a Ugandan subscriber number, excluding the country code. */
export const UGANDA_SUBSCRIBER_DIGITS = 9;

/**
 * Canonical stored form: `+256` plus nine digits.
 *
 * Mirrored by the `profiles_phone_e164_check` constraint in migration 0002.
 */
export const UGANDA_E164_PATTERN = /^\+256\d{9}$/;

/**
 * Leading digits of the subscriber number that denote a mobile line.
 *
 * `7x` covers MTN and Airtel mobile ranges; `3x` and `2x` cover ranges also
 * issued to mobile subscribers. Fixed lines (`4x`) are permitted as contacts
 * but are reported as non-mobile, because an SMS or a mobile-money transfer
 * cannot be sent to one.
 */
const MOBILE_PREFIXES: readonly string[] = ['7', '3', '2'];

/** Type guard for the canonical stored form. */
export function isUgandanPhone(value: unknown): value is string {
  return typeof value === 'string' && UGANDA_E164_PATTERN.test(value);
}

/**
 * Normalise anything a human might type into canonical E.164.
 *
 * Accepted inputs, all yielding `+256772123456`:
 *
 * ```
 * '+256772123456'   '256772123456'   '0772123456'   '772123456'
 * '+256 772 123 456'   '0772-123-456'   '(0772) 123456'
 * ```
 *
 * @throws PhoneError with a message written for staff when the number cannot
 *   be read as a Ugandan number.
 */
export function normalizeUgandanPhone(input: string): string {
  if (typeof input !== 'string') {
    throw new PhoneError('Phone number is required.');
  }

  const trimmed = input.trim();
  if (trimmed === '') {
    throw new PhoneError('Phone number is required.');
  }

  // Keep digits and a single leading '+'; drop spaces, dashes, dots, brackets.
  const hadPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');

  if (digits === '') {
    throw new PhoneError(`"${input}" does not contain any digits.`);
  }

  let subscriber: string;

  if (digits.startsWith(UGANDA_COUNTRY_CODE) && digits.length === 12) {
    // 256772123456
    subscriber = digits.slice(3);
  } else if (
    digits.startsWith(`00${UGANDA_COUNTRY_CODE}`) &&
    digits.length === UGANDA_SUBSCRIBER_DIGITS + 5
  ) {
    // 00256772123456 — the "00" international dialling prefix, then +256,
    // then nine subscriber digits.
    subscriber = digits.slice(5);
  } else if (digits.startsWith('0') && digits.length === UGANDA_SUBSCRIBER_DIGITS + 1) {
    // 0772123456 — the local form
    subscriber = digits.slice(1);
  } else if (digits.length === UGANDA_SUBSCRIBER_DIGITS && !hadPlus) {
    // 772123456 — subscriber number alone
    subscriber = digits;
  } else if (hadPlus && !digits.startsWith(UGANDA_COUNTRY_CODE)) {
    throw new PhoneError(
      `"${input}" looks like a non-Ugandan number. Only Ugandan numbers (+256) are supported.`,
    );
  } else {
    throw new PhoneError(
      `"${input}" is not a valid Ugandan phone number. Expected 9 digits after +256, for example 0772 123 456.`,
    );
  }

  if (subscriber.length !== UGANDA_SUBSCRIBER_DIGITS) {
    throw new PhoneError(
      `"${input}" has ${String(subscriber.length)} digits after the country code; a Ugandan number has ${String(UGANDA_SUBSCRIBER_DIGITS)}.`,
    );
  }

  if (subscriber.startsWith('0')) {
    throw new PhoneError(`"${input}" is not a valid Ugandan phone number.`);
  }

  return `+${UGANDA_COUNTRY_CODE}${subscriber}`;
}

/**
 * Normalise without throwing. Returns `null` on failure — convenient for
 * search inputs and optional fields.
 */
export function tryNormalizeUgandanPhone(input: string): string | null {
  try {
    return normalizeUgandanPhone(input);
  } catch {
    return null;
  }
}

/**
 * Could this number receive an SMS or a mobile-money transfer?
 *
 * Informational in Phase 1; the MTN and Airtel integrations in a later phase
 * will need it before attempting a disbursement.
 */
export function isMobileNumber(e164: string): boolean {
  if (!isUgandanPhone(e164)) return false;
  const subscriber = e164.slice(4);
  return MOBILE_PREFIXES.some((prefix) => subscriber.startsWith(prefix));
}

/**
 * Render for display in the local form staff recognise: `0772 123 456`.
 *
 * Receipts and exports should use the canonical E.164 form instead, so the
 * value stays unambiguous outside Uganda.
 */
export function formatUgandanPhoneLocal(e164: string): string {
  if (!isUgandanPhone(e164)) return e164;
  const subscriber = e164.slice(4);
  return `0${subscriber.slice(0, 2)} ${subscriber.slice(2, 5)} ${subscriber.slice(5)}`;
}

/** Render in international form with spacing: `+256 772 123 456`. */
export function formatUgandanPhoneInternational(e164: string): string {
  if (!isUgandanPhone(e164)) return e164;
  const subscriber = e164.slice(4);
  return `+${UGANDA_COUNTRY_CODE} ${subscriber.slice(0, 3)} ${subscriber.slice(3, 6)} ${subscriber.slice(6)}`;
}
