/**
 * Mapping a login identifier to a Supabase Auth identity.
 *
 * ## The decision: phone is the identifier, and the auth email is derived
 *
 * Supabase Auth authenticates against an email address. This business
 * identifies people by phone number — Phase 1 made `profiles.phone` the unique
 * business identifier precisely because many clients have no email at all.
 * Something has to bridge the two.
 *
 * Three ways to bridge it were considered:
 *
 *  1. **Look the phone up and find the account's email.** This needs a read of
 *     `profiles` before anyone is authenticated. Exposing that to `anon` is an
 *     account-enumeration oracle that also hands out email addresses; doing it
 *     with the secret key puts a privileged credential on the hot login path
 *     and makes the application unable to sign anyone in without it.
 *
 *  2. **Require every account to have a real email.** Wrong for the business:
 *     most borrowers do not have one, and inventing addresses for them is the
 *     same problem with extra steps.
 *
 *  3. **Derive the auth email deterministically from the phone number.**
 *     Chosen. `+256772123456` becomes `256772123456@phone.lending.invalid`.
 *     Sign-in needs no lookup at all, so there is no oracle to probe and no
 *     secret on the login path. Two people cannot collide, because the phone
 *     number they derive from is already unique.
 *
 * `.invalid` is reserved by RFC 2606 and can never be resolved or routed. That
 * is the point: these addresses are identifiers, not mailboxes. Nothing can
 * ever be sent to one, and one can never collide with a real address somebody
 * owns.
 *
 * ## What follows from this
 *
 * Supabase cannot email a password reset to an address that cannot receive
 * mail, so password recovery is **administrator-assisted** — an Owner issues a
 * temporary password and the account is forced to change it at next sign-in.
 * That is a consequence of the design, and it suits a business with no email
 * infrastructure. See docs/AUTHENTICATION.md.
 *
 * `profiles.email` remains contact information. It is never an auth identity
 * in this phase. If the business later wants genuine email sign-in, the route
 * is to make the auth email the real address for those accounts and accept
 * both identifier forms — a decision with its own trade-offs, recorded in
 * ADR-013.
 */

import { normalizeUgandanPhone, PhoneError } from '@/lib/domain/phone';

/**
 * Domain for derived authentication addresses.
 *
 * Under `.invalid` (RFC 2606), which is permanently unresolvable. An address
 * here can never receive mail and can never belong to anybody.
 */
export const AUTH_EMAIL_DOMAIN = 'phone.lending.invalid' as const;

export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityError';
  }
}

/**
 * The Supabase Auth email for a canonical E.164 phone number.
 *
 * ```
 * authEmailForPhone('+256772123456') // '256772123456@phone.lending.invalid'
 * ```
 *
 * The leading `+` is dropped because an email local-part may not begin with
 * one in every validator, and the country code makes it unambiguous anyway.
 *
 * @throws IdentityError if the number is not canonical. Callers normalise
 *   first; this refuses rather than guessing, so a malformed number cannot
 *   produce an address that silently fails to match the one used at sign-up.
 */
export function authEmailForPhone(e164Phone: string): string {
  if (!/^\+256\d{9}$/.test(e164Phone)) {
    throw new IdentityError(
      'An authentication address can only be derived from a canonical +256 phone number.',
    );
  }

  return `${e164Phone.slice(1)}@${AUTH_EMAIL_DOMAIN}`;
}

/** Is this address one of our derived identifiers rather than a real mailbox? */
export function isDerivedAuthEmail(email: string): boolean {
  return email.toLowerCase().endsWith(`@${AUTH_EMAIL_DOMAIN}`);
}

/**
 * Recover the phone number from a derived address.
 *
 * Used when reading an auth user back and reporting which account it is.
 * Returns `null` for a real address.
 */
export function phoneFromAuthEmail(email: string): string | null {
  if (!isDerivedAuthEmail(email)) return null;

  const localPart = email.slice(0, email.lastIndexOf('@'));
  if (!/^256\d{9}$/.test(localPart)) return null;

  return `+${localPart}`;
}

/**
 * Turn whatever a person typed into the login box into an auth address.
 *
 * Accepts every shape of Ugandan number staff and clients actually type —
 * `0772123456`, `+256 772 123 456`, `256772123456` — because they all
 * normalise to the same canonical form, and therefore to the same address.
 *
 * @throws IdentityError with a message safe to show at a login screen. It says
 *   the number is not a valid Ugandan number; it never says whether an account
 *   exists, because this function cannot know and must not appear to.
 */
export function authEmailForIdentifier(identifier: string): string {
  const trimmed = identifier.trim();

  if (trimmed === '') {
    throw new IdentityError('Enter your phone number.');
  }

  try {
    return authEmailForPhone(normalizeUgandanPhone(trimmed));
  } catch (error) {
    if (error instanceof PhoneError || error instanceof IdentityError) {
      throw new IdentityError(
        'Enter a valid Ugandan phone number, for example 0772 123 456.',
      );
    }
    throw error;
  }
}
