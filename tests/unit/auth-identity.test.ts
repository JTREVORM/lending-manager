import { describe, expect, it } from 'vitest';

import {
  AUTH_EMAIL_DOMAIN,
  IdentityError,
  authEmailForIdentifier,
  authEmailForPhone,
  isDerivedAuthEmail,
  phoneFromAuthEmail,
} from '@/lib/auth/identity';
import { normalizeUgandanPhone } from '@/lib/domain/phone';

describe('the derived authentication address', () => {
  it('uses a domain that can never receive mail or belong to anyone', () => {
    // RFC 2606 reserves `.invalid` permanently. These are identifiers, not
    // mailboxes — which is what makes it safe to mint one per phone number.
    expect(AUTH_EMAIL_DOMAIN.endsWith('.invalid')).toBe(true);
  });

  it('derives one address per canonical phone number', () => {
    expect(authEmailForPhone('+256772123456')).toBe(`256772123456@${AUTH_EMAIL_DOMAIN}`);
  });

  it('is deterministic, so sign-in needs no lookup', () => {
    // The whole design rests on this: if the address can be computed, there is
    // no pre-authentication database read, and therefore no enumeration oracle
    // and no secret key on the login path.
    expect(authEmailForPhone('+256772123456')).toBe(authEmailForPhone('+256772123456'));
  });

  it('gives different numbers different addresses', () => {
    expect(authEmailForPhone('+256772123456')).not.toBe(
      authEmailForPhone('+256772123457'),
    );
  });

  it('refuses a number that is not already canonical', () => {
    // Guessing at a malformed number would produce an address that silently
    // fails to match the one used at sign-up.
    for (const bad of ['0772123456', '772123456', '+256 772 123 456', '+254712345678']) {
      expect(() => authEmailForPhone(bad), bad).toThrow(IdentityError);
    }
  });

  it('round-trips back to the phone number', () => {
    const phone = '+256772123456';
    expect(phoneFromAuthEmail(authEmailForPhone(phone))).toBe(phone);
  });

  it('recognises its own addresses and not real ones', () => {
    expect(isDerivedAuthEmail(authEmailForPhone('+256772123456'))).toBe(true);
    expect(isDerivedAuthEmail('person@example.com')).toBe(false);
    expect(phoneFromAuthEmail('person@example.com')).toBeNull();
  });

  it('rejects a malformed local part that happens to use the domain', () => {
    expect(phoneFromAuthEmail(`notaphone@${AUTH_EMAIL_DOMAIN}`)).toBeNull();
  });
});

describe('authEmailForIdentifier', () => {
  it('accepts every form a person might type, mapping all to one address', () => {
    // Staff will type any of these for the same person. They must all reach
    // the same account, or the same user would be unable to sign in depending
    // on how they typed their own number.
    const expected = authEmailForPhone('+256772123456');

    for (const typed of [
      '0772123456',
      '+256772123456',
      '256772123456',
      '+256 772 123 456',
      '0772-123-456',
      '  0772 123 456  ',
      '00256772123456',
    ]) {
      expect(authEmailForIdentifier(typed), typed).toBe(expected);
    }
  });

  it('refuses a blank identifier', () => {
    expect(() => authEmailForIdentifier('')).toThrow(/Enter your phone number/);
    expect(() => authEmailForIdentifier('   ')).toThrow(IdentityError);
  });

  it('gives one message for every unparseable identifier', () => {
    // The message must not distinguish "that is not a phone number" from
    // "there is no such account" — doing so would start an enumeration oracle
    // at the login screen.
    const messages = new Set<string>();

    for (const bad of ['abc', '12345', '+254712345678', 'person@example.com', '!!!']) {
      try {
        authEmailForIdentifier(bad);
        throw new Error(`expected ${bad} to be refused`);
      } catch (error) {
        expect(error, bad).toBeInstanceOf(IdentityError);
        messages.add((error as IdentityError).message);
      }
    }

    expect(messages.size).toBe(1);
  });

  it('never reveals whether an account exists', () => {
    try {
      authEmailForIdentifier('+254712345678');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toMatch(/not found|no account|unknown user|exists/i);
    }
  });

  it('agrees with the phone normaliser the database constraint mirrors', () => {
    const canonical = normalizeUgandanPhone('0772123456');
    expect(authEmailForIdentifier('0772123456')).toBe(authEmailForPhone(canonical));
  });
});
