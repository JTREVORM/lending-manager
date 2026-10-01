/**
 * Application error taxonomy.
 *
 * Every error that crosses a boundary (Server Action, Route Handler, data
 * access function) is normalised into an `AppError`. That gives us two
 * separate channels:
 *
 *   - `userMessage` — safe to show a cashier or a client. Plain language, no
 *     SQL, no identifiers, no internals.
 *   - `cause` / `context` — kept server-side for the logs only.
 *
 * `toPublicError()` is the only sanctioned way to turn an error into something
 * that reaches a browser. It never includes the cause, the stack, or anything
 * that was not explicitly marked as safe.
 */

/** Stable, machine-readable error codes. Safe to expose. */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'NOT_AUTHENTICATED',
  'NOT_AUTHORIZED',
  'NOT_FOUND',
  'CONFLICT',
  'BUSINESS_RULE_VIOLATION',
  'DATABASE_ERROR',
  'CONFIGURATION_ERROR',
  'RATE_LIMITED',
  'UNEXPECTED_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Field-level validation problems, keyed by dotted field path. */
export type FieldErrors = Readonly<Record<string, readonly string[]>>;

/** Arbitrary diagnostic detail. Server-side only — never serialised to a client. */
export type ErrorContext = Readonly<Record<string, unknown>>;

/** The only error shape permitted to leave the server. */
export interface PublicError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly fieldErrors?: FieldErrors;
}

interface AppErrorOptions {
  /** Message shown to the end user. Must contain no internal detail. */
  readonly userMessage?: string;
  /** Underlying error, retained for logs only. */
  readonly cause?: unknown;
  /** Diagnostic context, retained for logs only. */
  readonly context?: ErrorContext;
}

/**
 * Base class for all deliberate application errors.
 *
 * `message` is the developer-facing description and may contain detail; it is
 * logged but never returned to a client. `userMessage` is what the UI shows.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly userMessage: string;
  readonly context: ErrorContext | undefined;

  /**
   * `true` for errors we anticipated and handled deliberately (validation,
   * authorization, business rules). `false` means a bug or an outage, which
   * monitoring should treat differently.
   */
  readonly isOperational: boolean;

  constructor(
    code: ErrorCode,
    httpStatus: number,
    message: string,
    options: AppErrorOptions = {},
    isOperational = true,
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = httpStatus;
    this.userMessage = options.userMessage ?? message;
    this.context = options.context;
    this.isOperational = isOperational;
  }

  /** Sanitised projection, safe to send to a browser. */
  toPublic(): PublicError {
    return { code: this.code, message: this.userMessage };
  }
}

/** Input failed schema or business-format validation. */
export class ValidationError extends AppError {
  readonly fieldErrors: FieldErrors;

  constructor(
    message = 'One or more fields are invalid.',
    fieldErrors: FieldErrors = {},
    options: AppErrorOptions = {},
  ) {
    super('VALIDATION_FAILED', 422, message, {
      userMessage: 'Please check the highlighted fields and try again.',
      ...options,
    });
    this.fieldErrors = fieldErrors;
  }

  override toPublic(): PublicError {
    return {
      code: this.code,
      message: this.userMessage,
      fieldErrors: this.fieldErrors,
    };
  }
}

/** No valid session. The caller must sign in. */
export class AuthenticationError extends AppError {
  constructor(message = 'No authenticated user.', options: AppErrorOptions = {}) {
    super('NOT_AUTHENTICATED', 401, message, {
      userMessage: 'Please sign in to continue.',
      ...options,
    });
  }
}

/** Authenticated, but not permitted to perform this action. */
export class AuthorizationError extends AppError {
  constructor(message = 'Permission denied.', options: AppErrorOptions = {}) {
    super('NOT_AUTHORIZED', 403, message, {
      userMessage: 'You do not have permission to do this.',
      ...options,
    });
  }
}

/** The requested record does not exist, or is not visible to this caller. */
export class NotFoundError extends AppError {
  constructor(message = 'Record not found.', options: AppErrorOptions = {}) {
    super('NOT_FOUND', 404, message, {
      userMessage: 'That record could not be found.',
      ...options,
    });
  }
}

/** Uniqueness or concurrency conflict — e.g. a duplicate phone number. */
export class ConflictError extends AppError {
  constructor(message = 'Conflicting record.', options: AppErrorOptions = {}) {
    super('CONFLICT', 409, message, {
      userMessage: 'That record already exists.',
      ...options,
    });
  }
}

/**
 * A lending rule was violated — e.g. a loan below the configured minimum.
 *
 * Unlike the other subclasses this one shows its `message` to the user, because
 * business-rule messages are written for staff ("Loan amount is below the
 * minimum of UGX 100,000"). Never put internal detail in one.
 */
export class BusinessRuleError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('BUSINESS_RULE_VIOLATION', 422, message, {
      userMessage: message,
      ...options,
    });
  }
}

/** A database operation failed. The underlying driver error is never exposed. */
export class DatabaseError extends AppError {
  constructor(message = 'Database operation failed.', options: AppErrorOptions = {}) {
    super(
      'DATABASE_ERROR',
      500,
      message,
      {
        userMessage: 'Something went wrong saving your data. Please try again.',
        ...options,
      },
      false,
    );
  }
}

/** Required configuration is missing or malformed. Fatal, and never the user's fault. */
export class ConfigurationError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super(
      'CONFIGURATION_ERROR',
      500,
      message,
      {
        userMessage:
          'The application is not configured correctly. Contact your administrator.',
        ...options,
      },
      false,
    );
  }
}

/** Anything unanticipated. Always treated as a bug. */
export class UnexpectedError extends AppError {
  constructor(message = 'Unexpected error.', options: AppErrorOptions = {}) {
    super(
      'UNEXPECTED_ERROR',
      500,
      message,
      {
        userMessage: 'Something went wrong. Please try again.',
        ...options,
      },
      false,
    );
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Coerce anything thrown into an `AppError`.
 *
 * Unknown throwables become `UnexpectedError` with the original value retained
 * as the cause, so the logs keep it while the user does not see it.
 */
export function normalizeError(error: unknown): AppError {
  if (isAppError(error)) return error;

  if (error instanceof Error) {
    return new UnexpectedError(error.message, { cause: error });
  }

  return new UnexpectedError('Non-error value thrown.', { cause: error });
}

/**
 * Sanitise any error for transport to a client.
 *
 * This is the boundary. Call it in Server Actions and Route Handlers; never
 * return a raw error, a `PostgrestError`, or `error.message` from an unknown
 * source.
 */
export function toPublicError(error: unknown): PublicError {
  return normalizeError(error).toPublic();
}
