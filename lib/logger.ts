/**
 * Structured logger with mandatory redaction.
 *
 * This is a lending system: logs will inevitably be handed to a developer, a
 * host provider, or an aggregation service. Three rules follow from that, and
 * they are enforced here rather than left to the caller's discretion:
 *
 *   1. Secrets never appear. Keys whose name looks sensitive are replaced with
 *      a marker, at any depth.
 *   2. Values that look like credentials are replaced even when the key name
 *      is innocuous, because `{ note: 'sb_secret_...' }` is just as leaked.
 *   3. Personal and financial detail is opt-in. Pass identifiers, not records.
 *      Helpers are provided for the two cases that come up constantly — phone
 *      numbers and money.
 *
 * Output is one JSON object per line outside development, which is what log
 * aggregators expect. In development it prints a readable single line.
 *
 * This is NOT the audit log. Audit records are durable, queryable rows in
 * `public.audit_log`; these are transient diagnostics. See docs/DECISIONS.md
 * (ADR-009).
 */

import { LOG_LEVELS, type LogLevel } from '@/config/app';

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Replacement text written in place of a redacted value. */
export const REDACTED = '[redacted]' as const;

/**
 * Key names whose values are never logged.
 *
 * Matched as a substring of the key with separators stripped and case folded,
 * so one entry covers every spelling a key arrives in: `api_key`, `apiKey`,
 * `x-api-key` and `API-KEY` all normalise to `apikey`. HTTP headers are
 * hyphenated and database columns are snake_case, so matching the raw key
 * would miss half of them.
 */
const SENSITIVE_KEY_PATTERNS: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'authorization',
  'auth',
  'cookie',
  'session',
  'credential',
  'privatekey',
  'servicerole',
  'jwt',
  'bearer',
  'signature',
  'pin',
  'otp',
  'cvv',
  // Ugandan National Identification Number and other identity documents.
  'nin',
  'nationalid',
  'idnumber',
  'passport',
  // Payment instrument details, relevant once MTN/Airtel land in a later phase.
  'accountnumber',
  'card',
  'msisdn',
];

/**
 * Value shapes that are credentials regardless of the key they sit under.
 * Keep these anchored and specific so ordinary text is not mangled.
 */
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsb_secret_[A-Za-z0-9_-]+/g, // Supabase secret key
  /\bsb_publishable_[A-Za-z0-9_-]+/g, // publishable key — not secret, but noise
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, // JWT
  /\bsbp_[A-Za-z0-9]{20,}/g, // Supabase personal access token
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub token
  /\bpostgres(?:ql)?:\/\/[^\s"']+/gi, // connection string with credentials
  /\bBearer\s+[A-Za-z0-9._-]{10,}/gi,
];

/** Guard against unbounded log lines from a stray large object. */
const MAX_STRING_LENGTH = 2_000;
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;

/**
 * Does this key name look like it holds a secret?
 *
 * Exported for direct testing: the rule is a security control, so it is
 * asserted against explicitly rather than only through `redact`.
 */
export function isSensitiveKey(key: string): boolean {
  // Strip separators so `x-api-key`, `api_key` and `apiKey` all compare equal.
  const normalised = key.toLowerCase().replace(/[-_\s.]/g, '');
  return SENSITIVE_KEY_PATTERNS.some((pattern) => normalised.includes(pattern));
}

function redactString(value: string): string {
  let result = value;
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  if (result.length > MAX_STRING_LENGTH) {
    result = `${result.slice(0, MAX_STRING_LENGTH)}…[truncated]`;
  }
  return result;
}

/**
 * Recursively strip sensitive data from an arbitrary value.
 *
 * Exported so the redaction rules can be unit-tested directly — the behaviour
 * here is a security control, not a formatting detail.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;

  if (depth >= MAX_DEPTH) return '[max depth]';

  if (typeof value === 'string') return redactString(value);

  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (typeof value === 'bigint') return value.toString();

  if (typeof value === 'function' || typeof value === 'symbol') {
    return `[${typeof value}]`;
  }

  if (value instanceof Date) return value.toISOString();

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      // Stacks are kept server-side for diagnosis. They are never part of a
      // response body — see lib/errors.ts `toPublicError`.
      stack: value.stack === undefined ? undefined : redactString(value.stack),
      cause: value.cause === undefined ? undefined : redact(value.cause, depth + 1),
    };
  }

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redact(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`[${value.length - MAX_ARRAY_ITEMS} more items]`);
    }
    return items;
  }

  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      output[key] = isSensitiveKey(key) ? REDACTED : redact(source[key], depth + 1);
    }
    return output;
  }

  return '[unserialisable]';
}

/** Structured fields attached to a log entry. */
export type LogContext = Record<string, unknown>;

export interface LogEntry {
  readonly level: LogLevel;
  readonly time: string;
  readonly message: string;
  readonly context?: Record<string, unknown>;
}

function resolveMinLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (raw !== undefined && (LOG_LEVELS as readonly string[]).includes(raw)) {
    return raw as LogLevel;
  }
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

function isPretty(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test';
}

/**
 * Build a log entry without writing it. Exported for tests so assertions can
 * inspect the exact structure and redaction result.
 */
export function buildEntry(
  level: LogLevel,
  message: string,
  context?: LogContext,
): LogEntry {
  const redactedContext =
    context === undefined
      ? undefined
      : (redact(context) as Record<string, unknown> | undefined);

  return {
    level,
    time: new Date().toISOString(),
    message: redactString(message),
    ...(redactedContext === undefined ? {} : { context: redactedContext }),
  };
}

function write(entry: LogEntry): void {
  const line = isPretty()
    ? `${entry.time} ${entry.level.toUpperCase().padEnd(5)} ${entry.message}${
        entry.context === undefined ? '' : ` ${JSON.stringify(entry.context)}`
      }`
    : JSON.stringify(entry);

  // The single sanctioned `console` usage in the codebase; ESLint forbids it
  // everywhere else so that nothing bypasses redaction.
  if (entry.level === 'error') {
    console.error(line);
  } else if (entry.level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  /** Derive a logger that merges `bindings` into every subsequent entry. */
  child(bindings: LogContext): Logger;
}

function createLogger(bindings: LogContext = {}): Logger {
  const emit = (level: LogLevel, message: string, context?: LogContext): void => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[resolveMinLevel()]) return;

    const merged: LogContext | undefined =
      Object.keys(bindings).length === 0 && context === undefined
        ? undefined
        : { ...bindings, ...context };

    write(buildEntry(level, message, merged));
  };

  return {
    debug: (message, context) => emit('debug', message, context),
    info: (message, context) => emit('info', message, context),
    warn: (message, context) => emit('warn', message, context),
    error: (message, context) => emit('error', message, context),
    child: (extra) => createLogger({ ...bindings, ...extra }),
  };
}

/** Application-wide logger. Prefer `logger.child({ ... })` for request scope. */
export const logger: Logger = createLogger();

/**
 * Mask a phone number for logging: `+256772123456` → `+256772***456`.
 *
 * Enough to correlate a support call, not enough to be a usable contact list
 * if the logs leak.
 */
export function maskPhone(phone: string): string {
  if (phone.length <= 7) return REDACTED;
  return `${phone.slice(0, 7)}***${phone.slice(-3)}`;
}

/**
 * Mask an email for logging: `john.doe@example.com` → `j***@example.com`.
 */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at < 1) return REDACTED;
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

/**
 * Describe a money amount by magnitude instead of value.
 *
 * Exact balances in application logs are a privacy problem and are not needed
 * for debugging; the audit log is where exact figures belong. This reports the
 * order of magnitude, e.g. 250_000 → `'1e5..1e6 UGX'`.
 */
export function describeAmount(amountInShillings: number): string {
  if (!Number.isFinite(amountInShillings)) return 'non-finite';
  const magnitude = Math.abs(amountInShillings);
  if (magnitude === 0) return '0 UGX';
  const exponent = Math.floor(Math.log10(magnitude));
  return `1e${exponent}..1e${exponent + 1} UGX`;
}
