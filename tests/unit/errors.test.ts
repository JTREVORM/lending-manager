import { describe, expect, it } from 'vitest';

import { mapDatabaseError } from '@/lib/db-errors';
import {
  AppError,
  AuthenticationError,
  AuthorizationError,
  BusinessRuleError,
  ConfigurationError,
  ConflictError,
  DatabaseError,
  ERROR_CODES,
  NotFoundError,
  UnexpectedError,
  ValidationError,
  isAppError,
  normalizeError,
  toPublicError,
} from '@/lib/errors';

describe('error taxonomy', () => {
  it('maps each error class to its code and HTTP status', () => {
    const cases = [
      [new ValidationError(), 'VALIDATION_FAILED', 422],
      [new AuthenticationError(), 'NOT_AUTHENTICATED', 401],
      [new AuthorizationError(), 'NOT_AUTHORIZED', 403],
      [new NotFoundError(), 'NOT_FOUND', 404],
      [new ConflictError(), 'CONFLICT', 409],
      [new BusinessRuleError('Below minimum.'), 'BUSINESS_RULE_VIOLATION', 422],
      [new DatabaseError(), 'DATABASE_ERROR', 500],
      [new ConfigurationError('missing'), 'CONFIGURATION_ERROR', 500],
      [new UnexpectedError(), 'UNEXPECTED_ERROR', 500],
    ] as const;

    for (const [error, code, status] of cases) {
      expect(error.code).toBe(code);
      expect(error.httpStatus).toBe(status);
      expect(ERROR_CODES).toContain(error.code);
      expect(error).toBeInstanceOf(AppError);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe(error.constructor.name);
    }
  });

  it('marks anticipated failures operational and bugs not', () => {
    // Monitoring should page on the second group, not the first.
    expect(new ValidationError().isOperational).toBe(true);
    expect(new AuthorizationError().isOperational).toBe(true);
    expect(new BusinessRuleError('x').isOperational).toBe(true);

    expect(new DatabaseError().isOperational).toBe(false);
    expect(new ConfigurationError('x').isOperational).toBe(false);
    expect(new UnexpectedError().isOperational).toBe(false);
  });

  it('retains the cause for logging', () => {
    const cause = new Error('root cause');
    expect(new DatabaseError('failed', { cause }).cause).toBe(cause);
  });
});

describe('user-facing messages', () => {
  it('never leaks the developer message for internal failures', () => {
    const error = new DatabaseError(
      'insert into "profiles" violated constraint "profiles_phone_key"',
    );

    expect(error.toPublic().message).toBe(
      'Something went wrong saving your data. Please try again.',
    );
    expect(error.toPublic().message).not.toContain('profiles');
    expect(error.toPublic().message).not.toContain('constraint');
  });

  it('never leaks a configuration message naming environment variables', () => {
    const error = new ConfigurationError('SUPABASE_SECRET_KEY is not configured.');

    expect(error.toPublic().message).not.toContain('SUPABASE');
    expect(error.toPublic().message).toContain('not configured correctly');
  });

  it('shows business-rule messages verbatim, because they are written for staff', () => {
    const message = 'Loan amount is below the minimum of UGX 100,000.';
    expect(new BusinessRuleError(message).toPublic().message).toBe(message);
  });

  it('omits the cause and the stack from the public projection', () => {
    const error = new DatabaseError('internal', { cause: new Error('secret detail') });
    const serialised = JSON.stringify(error.toPublic());

    expect(serialised).not.toContain('secret detail');
    expect(serialised).not.toContain('stack');
    expect(Object.keys(error.toPublic()).sort()).toEqual(['code', 'message']);
  });
});

describe('ValidationError field errors', () => {
  it('carries field-keyed messages through to the public projection', () => {
    const error = new ValidationError('Invalid.', {
      phone: ['Enter a valid Ugandan phone number.'],
      amount: ['Amount must be a whole number of shillings.'],
    });

    expect(error.toPublic().fieldErrors?.phone).toEqual([
      'Enter a valid Ugandan phone number.',
    ]);
    expect(error.toPublic().code).toBe('VALIDATION_FAILED');
  });
});

describe('normalizeError', () => {
  it('passes an AppError through unchanged', () => {
    const error = new NotFoundError();
    expect(normalizeError(error)).toBe(error);
  });

  it('wraps a plain Error, keeping it as the cause', () => {
    const original = new Error('boom');
    const normalised = normalizeError(original);

    expect(normalised).toBeInstanceOf(UnexpectedError);
    expect(normalised.message).toBe('boom');
    expect(normalised.cause).toBe(original);
  });

  it('wraps a non-error throwable', () => {
    for (const thrown of ['a string', 42, null, undefined, { weird: true }]) {
      const normalised = normalizeError(thrown);
      expect(normalised).toBeInstanceOf(UnexpectedError);
      expect(normalised.message).toBe('Non-error value thrown.');
    }
  });
});

describe('toPublicError', () => {
  it('sanitises anything, including a raw thrown string', () => {
    expect(toPublicError('sb_secret_leak').code).toBe('UNEXPECTED_ERROR');
    expect(toPublicError('sb_secret_leak').message).toBe(
      'Something went wrong. Please try again.',
    );
  });
});

describe('isAppError', () => {
  it('discriminates', () => {
    expect(isAppError(new ValidationError())).toBe(true);
    expect(isAppError(new Error('plain'))).toBe(false);
    expect(isAppError('string')).toBe(false);
  });
});

describe('mapDatabaseError', () => {
  it('maps each SQLSTATE to the right application error', () => {
    const cases = [
      ['23505', ConflictError, 'CONFLICT'],
      ['23503', ValidationError, 'VALIDATION_FAILED'],
      ['23502', ValidationError, 'VALIDATION_FAILED'],
      ['23514', BusinessRuleError, 'BUSINESS_RULE_VIOLATION'],
      ['23P01', BusinessRuleError, 'BUSINESS_RULE_VIOLATION'],
      ['42501', AuthorizationError, 'NOT_AUTHORIZED'],
      ['40001', DatabaseError, 'DATABASE_ERROR'],
      ['40P01', DatabaseError, 'DATABASE_ERROR'],
      ['P0001', BusinessRuleError, 'BUSINESS_RULE_VIOLATION'],
      ['P0002', NotFoundError, 'NOT_FOUND'],
      ['PGRST116', NotFoundError, 'NOT_FOUND'],
    ] as const;

    for (const [code, constructor, expectedCode] of cases) {
      const mapped = mapDatabaseError({ code, message: 'raw detail' }, 'client');
      expect(mapped, `SQLSTATE ${code}`).toBeInstanceOf(constructor);
      expect(mapped.code).toBe(expectedCode);
    }
  });

  it('treats a Row Level Security write denial as an authorization failure', () => {
    // 42501 is what an RLS denial on a write looks like from PostgREST.
    expect(mapDatabaseError({ code: '42501' }).code).toBe('NOT_AUTHORIZED');
  });

  it('falls back to a generic database error for an unknown code', () => {
    expect(mapDatabaseError({ code: 'XX999' }).code).toBe('DATABASE_ERROR');
    expect(mapDatabaseError({}).code).toBe('DATABASE_ERROR');
    expect(mapDatabaseError(null).code).toBe('DATABASE_ERROR');
    expect(mapDatabaseError('not an object').code).toBe('DATABASE_ERROR');
  });

  it('uses the resource label in the user-facing message', () => {
    expect(mapDatabaseError({ code: '23505' }, 'client').toPublic().message).toBe(
      'That client already exists.',
    );
  });

  it('never exposes the raw message, details or hint', () => {
    const raw = {
      code: '23505',
      message: 'duplicate key value violates unique constraint "profiles_phone_key"',
      details: 'Key (phone)=(+256772123456) already exists.',
      hint: 'check the profiles table',
    };

    const publicShape = JSON.stringify(mapDatabaseError(raw, 'client').toPublic());

    // The row value in `details` is personal data; the constraint name in
    // `message` describes the schema. Neither may reach a browser.
    expect(publicShape).not.toContain('profiles_phone_key');
    expect(publicShape).not.toContain('+256772123456');
    expect(publicShape).not.toContain('unique constraint');
  });

  it('keeps the SQLSTATE in context for logs but not in the user message', () => {
    const mapped = mapDatabaseError({ code: '23505' }, 'client');

    expect(mapped.context?.sqlstate).toBe('23505');
    expect(mapped.toPublic().message).not.toContain('23505');
  });

  it('excludes the raw message from the logged context too', () => {
    // The context is logged. `details` can embed a row value, so it must not
    // be copied in even for diagnostics — the cause carries it instead.
    const mapped = mapDatabaseError(
      { code: '23505', details: 'Key (phone)=(+256772123456) already exists.' },
      'client',
    );

    expect(JSON.stringify(mapped.context)).not.toContain('+256772123456');
  });
});
