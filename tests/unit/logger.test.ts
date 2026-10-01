import { describe, expect, it } from 'vitest';

import {
  REDACTED,
  buildEntry,
  describeAmount,
  isSensitiveKey,
  maskEmail,
  maskPhone,
  redact,
} from '@/lib/logger';

/**
 * Synthetic credentials, assembled at runtime rather than written as literals.
 *
 * These have to match the real formats exactly, or the redaction patterns they
 * exercise would not be under test. That creates a second problem: a literal
 * `sb_secret_...` in a committed file is indistinguishable from a leaked key —
 * to an automated secret scanner, and to a person skimming the diff. Building
 * them from parts keeps the assertions just as strong while leaving nothing in
 * the repository that reads as a real credential.
 *
 * None of these values has ever been valid anywhere.
 */
const FAKE = {
  supabaseSecretKey: ['sb', 'secret', 'abcdefghijklmnopqrstuv', '12345678'].join('_'),
  supabaseAccessToken: ['sbp', '0123456789abcdef0123456789abcdef01234567'].join('_'),
  jwt: [
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
    'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  ].join('.'),
  connectionString: ['postgresql', '//user:pass@db.example.com:5432/app'].join(':'),
} as const;

/** The leading fragment an assertion checks has been removed. */
const SECRET_PREFIX = ['sb', 'secret', 'abcdefghij'].join('_');
const JWT_HEADER = FAKE.jwt.split('.')[0]!;

/**
 * Redaction is a security control, not formatting, so it is tested as one:
 * these assertions are what stop a secret reaching a log aggregator.
 */
describe('redact — sensitive key names', () => {
  it('removes values under obviously sensitive keys', () => {
    const result = redact({
      password: 'hunter2',
      SUPABASE_SECRET_KEY: FAKE.supabaseSecretKey,
      authToken: 'abc123',
      'x-api-key': 'k',
      cookie: 'sb-access-token=x',
      jwt: 'y',
    }) as Record<string, unknown>;

    expect(result.password).toBe(REDACTED);
    expect(result.SUPABASE_SECRET_KEY).toBe(REDACTED);
    expect(result.authToken).toBe(REDACTED);
    expect(result['x-api-key']).toBe(REDACTED);
    expect(result.cookie).toBe(REDACTED);
    expect(result.jwt).toBe(REDACTED);
  });

  it('removes identity-document and payment fields', () => {
    const result = redact({
      nin: 'CM12345678ABCD',
      national_id: 'CM12345678ABCD',
      passport: 'B1234567',
      account_number: '1234567890',
      msisdn: '+256772123456',
      pin: '1234',
      otp: '998877',
    }) as Record<string, unknown>;

    for (const value of Object.values(result)) {
      expect(value).toBe(REDACTED);
    }
  });

  it('matches case-insensitively and as a substring', () => {
    const result = redact({
      MY_PASSWORD_FIELD: 'x',
      refreshTokenValue: 'y',
    }) as Record<string, unknown>;

    expect(result.MY_PASSWORD_FIELD).toBe(REDACTED);
    expect(result.refreshTokenValue).toBe(REDACTED);
  });

  it('redacts at any nesting depth', () => {
    const result = redact({
      request: { headers: { authorization: 'Bearer abc' }, path: '/loans' },
    }) as { request: { headers: { authorization: string }; path: string } };

    expect(result.request.headers.authorization).toBe(REDACTED);
    // Non-sensitive siblings survive, or the logs would be useless.
    expect(result.request.path).toBe('/loans');
  });

  it('redacts inside arrays of objects', () => {
    const result = redact([{ secret: 'a' }, { safe: 'b' }]) as Record<string, unknown>[];

    expect(result[0]?.secret).toBe(REDACTED);
    expect(result[1]?.safe).toBe('b');
  });
});

describe('redact — sensitive value shapes', () => {
  it('removes a credential even under an innocuous key', () => {
    // `{ note: 'sb_secret_...' }` leaks just as badly as `{ secret: ... }`.
    const result = redact({
      note: `the key is ${FAKE.supabaseSecretKey} ok`,
    }) as Record<string, string>;

    expect(result.note).not.toContain(SECRET_PREFIX);
    expect(result.note).toContain(REDACTED);
  });

  it('removes a JWT found in free text', () => {
    const result = redact({ message: `token=${FAKE.jwt}` }) as Record<string, string>;

    expect(result.message).not.toContain(JWT_HEADER);
    expect(result.message).toContain(REDACTED);
  });

  it('removes a database connection string with embedded credentials', () => {
    const result = redact({
      detail: `failed to connect to ${FAKE.connectionString}`,
    }) as Record<string, string>;

    expect(result.detail).not.toContain('pass@');
    expect(result.detail).toContain(REDACTED);
  });

  it('removes a bearer token and a personal access token', () => {
    const result = redact({
      a: 'Bearer abcdefghijklmnopqrstuvwxyz',
      b: FAKE.supabaseAccessToken,
    }) as Record<string, string>;

    expect(result.a).toContain(REDACTED);
    expect(result.b).toContain(REDACTED);
  });

  it('leaves ordinary business text intact', () => {
    const result = redact({
      message: 'Loan LN260001 created for client CL26001',
    }) as Record<string, string>;

    expect(result.message).toBe('Loan LN260001 created for client CL26001');
  });
});

describe('redact — structural safety', () => {
  it('preserves primitives and dates', () => {
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
    expect(redact(10n)).toBe('10');
    expect(redact(new Date('2026-01-14T00:00:00Z'))).toBe('2026-01-14T00:00:00.000Z');
  });

  it('serialises an Error with its message, stack and cause', () => {
    const cause = new Error('inner');
    const error = new Error('outer', { cause });
    const result = redact(error) as {
      name: string;
      message: string;
      stack: string;
      cause: { message: string };
    };

    expect(result.name).toBe('Error');
    expect(result.message).toBe('outer');
    expect(result.stack).toContain('outer');
    expect(result.cause.message).toBe('inner');
  });

  it('redacts a credential inside an error message', () => {
    const error = new Error(`auth failed with ${FAKE.supabaseSecretKey}`);
    const result = redact(error) as { message: string };

    expect(result.message).not.toContain(SECRET_PREFIX);
  });

  it('truncates a very long string instead of flooding the log', () => {
    const { blob } = redact({ blob: 'x'.repeat(5_000) }) as { blob: string };

    expect(blob).toContain('[truncated]');
    expect(blob.length).toBeLessThan(2_100);
  });

  it('caps array length', () => {
    const result = redact(Array.from({ length: 200 }, (_, index) => index)) as unknown[];

    expect(result.length).toBeLessThanOrEqual(51);
    expect(result.at(-1)).toContain('more items');
  });

  it('stops at a depth limit, so a cyclic object cannot hang the logger', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;

    // Terminates and produces something serialisable.
    expect(() => JSON.stringify(redact(cyclic))).not.toThrow();
    expect(JSON.stringify(redact(cyclic))).toContain('max depth');
  });

  it('describes functions and symbols rather than dropping them silently', () => {
    const result = redact({ fn: () => undefined, sym: Symbol('s') }) as Record<
      string,
      string
    >;

    expect(result.fn).toBe('[function]');
    expect(result.sym).toBe('[symbol]');
  });
});

describe('buildEntry', () => {
  it('produces a structured, serialisable entry', () => {
    const entry = buildEntry('info', 'Loan created', { loanId: 'LN260001' });

    expect(entry.level).toBe('info');
    expect(entry.message).toBe('Loan created');
    expect(entry.context).toEqual({ loanId: 'LN260001' });
    expect(() => new Date(entry.time).toISOString()).not.toThrow();
    expect(() => JSON.stringify(entry)).not.toThrow();
  });

  it('redacts the message itself, not only the context', () => {
    const entry = buildEntry('error', `failed: ${FAKE.supabaseSecretKey}`);

    expect(entry.message).not.toContain(SECRET_PREFIX);
  });

  it('omits the context key entirely when there is none', () => {
    expect(buildEntry('debug', 'plain').context).toBeUndefined();
  });
});

describe('masking helpers', () => {
  it('masks a phone enough to correlate but not to contact', () => {
    expect(maskPhone('+256772123456')).toBe('+256772***456');
    expect(maskPhone('short')).toBe(REDACTED);
  });

  it('masks an email', () => {
    expect(maskEmail('john.doe@example.com')).toBe('j***@example.com');
    expect(maskEmail('not-an-email')).toBe(REDACTED);
    expect(maskEmail('@example.com')).toBe(REDACTED);
  });

  it('describes an amount by magnitude, keeping exact figures out of logs', () => {
    // Exact balances belong in the audit log, not in diagnostics.
    expect(describeAmount(250_000)).toBe('1e5..1e6 UGX');
    expect(describeAmount(0)).toBe('0 UGX');
    expect(describeAmount(Number.NaN)).toBe('non-finite');
    expect(describeAmount(250_000)).not.toContain('250');
  });
});

describe('isSensitiveKey', () => {
  it('matches across every separator style a key arrives in', () => {
    // HTTP headers are hyphenated, database columns are snake_case and
    // JavaScript properties are camelCase; one rule must cover all three.
    for (const key of ['api_key', 'apiKey', 'x-api-key', 'API-KEY', 'X_API_KEY']) {
      expect(isSensitiveKey(key)).toBe(true);
    }

    for (const key of ['service_role', 'serviceRole', 'service-role']) {
      expect(isSensitiveKey(key)).toBe(true);
    }

    for (const key of ['national_id', 'nationalId', 'national-id']) {
      expect(isSensitiveKey(key)).toBe(true);
    }
  });

  it('leaves ordinary business field names alone', () => {
    // Over-matching would strip the context that makes a log useful.
    for (const key of [
      'loanId',
      'clientNumber',
      'amount',
      'status',
      'created_at',
      'full_name',
      'reference',
      'entity_type',
    ]) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });
});
