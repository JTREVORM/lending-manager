/**
 * Translate PostgreSQL / PostgREST failures into the application error
 * taxonomy, without ever letting the raw database message reach a user.
 *
 * Supabase returns `PostgrestError` objects whose `message`, `details` and
 * `hint` routinely contain table names, column names, constraint names and
 * fragments of SQL. Those are useful in a log and dangerous in a browser, so
 * everything goes through here: the original is attached as `cause` (logged)
 * and the user gets a sentence written for them.
 *
 * SQLSTATE reference: https://www.postgresql.org/docs/current/errcodes-appendix.html
 */

import {
  AuthorizationError,
  BusinessRuleError,
  ConflictError,
  DatabaseError,
  NotFoundError,
  ValidationError,
  type AppError,
} from './errors';

/** The error shape `@supabase/supabase-js` returns from PostgREST calls. */
export interface PostgresErrorLike {
  readonly code?: string | null;
  readonly message?: string | null;
  readonly details?: string | null;
  readonly hint?: string | null;
}

const SQLSTATE = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  NOT_NULL_VIOLATION: '23502',
  CHECK_VIOLATION: '23514',
  EXCLUSION_VIOLATION: '23P01',
  INSUFFICIENT_PRIVILEGE: '42501',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
  RAISE_EXCEPTION: 'P0001',
  NO_DATA_FOUND: 'P0002',
} as const;

/** PostgREST's own codes, which are not SQLSTATEs. */
const POSTGREST = {
  /** `.single()` matched zero rows. */
  NO_ROWS: 'PGRST116',
} as const;

function isPostgresErrorLike(value: unknown): value is PostgresErrorLike {
  return typeof value === 'object' && value !== null;
}

/**
 * Map a database failure to an `AppError`.
 *
 * `resourceLabel` is a human phrase used in the user-facing message, e.g.
 * `'client'` produces "That client already exists." Keep it a plain noun — it
 * is shown to staff, so never pass a table name.
 */
export function mapDatabaseError(error: unknown, resourceLabel = 'record'): AppError {
  if (!isPostgresErrorLike(error)) {
    return new DatabaseError('Unrecognised database failure.', { cause: error });
  }

  const code = typeof error.code === 'string' ? error.code : '';

  // Context is logged, never returned. Deliberately excludes `message`,
  // `details` and `hint`, which can embed row values and therefore PII.
  const context = { sqlstate: code, resource: resourceLabel } as const;

  switch (code) {
    case SQLSTATE.UNIQUE_VIOLATION:
      return new ConflictError(`Unique constraint violated on ${resourceLabel}.`, {
        userMessage: `That ${resourceLabel} already exists.`,
        cause: error,
        context,
      });

    case SQLSTATE.FOREIGN_KEY_VIOLATION:
      return new ValidationError(
        `Foreign key violated on ${resourceLabel}.`,
        {},
        {
          userMessage:
            'A linked record is missing or still in use. Please check your selection.',
          cause: error,
          context,
        },
      );

    case SQLSTATE.NOT_NULL_VIOLATION:
      return new ValidationError(
        `Required column missing on ${resourceLabel}.`,
        {},
        {
          userMessage: 'A required field is missing. Please complete the form.',
          cause: error,
          context,
        },
      );

    case SQLSTATE.CHECK_VIOLATION:
    case SQLSTATE.EXCLUSION_VIOLATION:
      return new BusinessRuleError(
        `The ${resourceLabel} does not satisfy the rules configured for it.`,
        { cause: error, context },
      );

    case SQLSTATE.INSUFFICIENT_PRIVILEGE:
      // Also what a Row Level Security denial on a write looks like.
      return new AuthorizationError(`Privilege denied on ${resourceLabel}.`, {
        cause: error,
        context,
      });

    case SQLSTATE.SERIALIZATION_FAILURE:
    case SQLSTATE.DEADLOCK_DETECTED:
      return new DatabaseError(`Transaction conflict on ${resourceLabel}.`, {
        userMessage: 'The system was busy. Please try that again.',
        cause: error,
        context,
      });

    case SQLSTATE.RAISE_EXCEPTION:
      // A deliberate `RAISE EXCEPTION` from one of our own triggers or
      // functions. The text is ours, but it is written for developers, so the
      // user still gets a generic sentence.
      return new BusinessRuleError(
        `That action is not permitted on this ${resourceLabel}.`,
        { cause: error, context },
      );

    case SQLSTATE.NO_DATA_FOUND:
    case POSTGREST.NO_ROWS:
      return new NotFoundError(`No ${resourceLabel} matched.`, {
        userMessage: `That ${resourceLabel} could not be found.`,
        cause: error,
        context,
      });

    default:
      return new DatabaseError(`Database error on ${resourceLabel}.`, {
        cause: error,
        context,
      });
  }
}
