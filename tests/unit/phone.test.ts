import { describe, expect, it } from 'vitest';

import {
  PhoneError,
  UGANDA_E164_PATTERN,
  formatUgandanPhoneInternational,
  formatUgandanPhoneLocal,
  isMobileNumber,
  isUgandanPhone,
  normalizeUgandanPhone,
  tryNormalizeUgandanPhone,
} from '@/lib/domain/phone';

describe('normalizeUgandanPhone', () => {
  it('converges every form staff type onto one canonical value', () => {
    // This is what makes the UNIQUE constraint on profiles.phone meaningful:
    // one person cannot be stored twice under two spellings.
    const canonical = '+256772123456';

    for (const input of [
      '+256772123456',
      '256772123456',
      '0772123456',
      '772123456',
      '+256 772 123 456',
      '0772-123-456',
      '(0772) 123456',
      '  0772 123 456  ',
      '0772.123.456',
      '00256772123456',
    ]) {
      expect(normalizeUgandanPhone(input)).toBe(canonical);
    }
  });

  it('handles the Airtel and MTN prefix ranges alike', () => {
    expect(normalizeUgandanPhone('0700123456')).toBe('+256700123456');
    expect(normalizeUgandanPhone('0750123456')).toBe('+256750123456');
    expect(normalizeUgandanPhone('0780123456')).toBe('+256780123456');
    expect(normalizeUgandanPhone('0392123456')).toBe('+256392123456');
  });

  it('rejects a number with the wrong digit count', () => {
    expect(() => normalizeUgandanPhone('077212345')).toThrow(PhoneError);
    expect(() => normalizeUgandanPhone('07721234567')).toThrow(PhoneError);
    expect(() => normalizeUgandanPhone('+25677212345')).toThrow(PhoneError);
  });

  it('rejects a non-Ugandan international number with a clear message', () => {
    expect(() => normalizeUgandanPhone('+254712345678')).toThrow(/non-Ugandan/);
    expect(() => normalizeUgandanPhone('+447700900123')).toThrow(/non-Ugandan/);
  });

  it('rejects blanks and text', () => {
    expect(() => normalizeUgandanPhone('')).toThrow(/required/);
    expect(() => normalizeUgandanPhone('   ')).toThrow(/required/);
    expect(() => normalizeUgandanPhone('not a phone')).toThrow(
      /does not contain any digits/,
    );
  });

  it('rejects a subscriber number that starts with zero', () => {
    expect(() => normalizeUgandanPhone('00123456789')).toThrow(PhoneError);
  });

  it('is idempotent, so re-saving a record cannot corrupt it', () => {
    const once = normalizeUgandanPhone('0772123456');
    expect(normalizeUgandanPhone(once)).toBe(once);
  });
});

describe('tryNormalizeUgandanPhone', () => {
  it('returns null instead of throwing, for search inputs', () => {
    expect(tryNormalizeUgandanPhone('0772123456')).toBe('+256772123456');
    expect(tryNormalizeUgandanPhone('rubbish')).toBeNull();
  });
});

describe('isUgandanPhone', () => {
  it('accepts only the canonical stored form', () => {
    expect(isUgandanPhone('+256772123456')).toBe(true);
    // The local form is valid input but is never what gets stored.
    expect(isUgandanPhone('0772123456')).toBe(false);
    expect(isUgandanPhone('+256 772 123 456')).toBe(false);
    expect(isUgandanPhone(null)).toBe(false);
  });

  it('uses the same pattern the database CHECK constraint enforces', () => {
    // Mirrors profiles_phone_e164 in migration 20261001000200.
    expect(UGANDA_E164_PATTERN.source).toBe('^\\+256\\d{9}$');
  });
});

describe('isMobileNumber', () => {
  it('identifies lines that can receive SMS and mobile money', () => {
    expect(isMobileNumber('+256772123456')).toBe(true);
    expect(isMobileNumber('+256700123456')).toBe(true);
    expect(isMobileNumber('+256392123456')).toBe(true);
    // A Kampala fixed line is a valid contact but cannot take a transfer.
    expect(isMobileNumber('+256414123456')).toBe(false);
  });

  it('returns false for a non-canonical value rather than guessing', () => {
    expect(isMobileNumber('0772123456')).toBe(false);
  });
});

describe('display formatting', () => {
  it('renders the local form staff recognise', () => {
    expect(formatUgandanPhoneLocal('+256772123456')).toBe('077 212 3456');
  });

  it('renders the international form for receipts and exports', () => {
    expect(formatUgandanPhoneInternational('+256772123456')).toBe('+256 772 123 456');
  });

  it('passes a non-canonical value through unchanged rather than mangling it', () => {
    expect(formatUgandanPhoneLocal('invalid')).toBe('invalid');
  });
});
