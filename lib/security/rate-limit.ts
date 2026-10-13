import 'server-only';

import { createHash } from 'node:crypto';

import { headers } from 'next/headers';

import { logger } from '@/lib/logger';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Rate limiting, per action rather than per application.
 *
 * ## Why one global limit would be wrong
 *
 * A cashier at a market counter records a payment every few seconds on a busy
 * morning. A sign-in attempt every few seconds is somebody guessing a
 * password. One number cannot describe both, and the number that protects
 * sign-in would stop the business working.
 *
 * So each action carries its own budget, chosen from what the work actually
 * looks like. The table below is the whole policy; there is no default that
 * quietly applies to something nobody considered, because `LIMITS` is a
 * closed map and the type system refuses an action that is not in it.
 *
 * ## What is counted, and against whom
 *
 * The key is a hash of the action and a subject. The subject is the
 * **signed-in profile** wherever there is one: limiting a logged-in cashier
 * by IP would throttle the whole office, which shares one connection. Before
 * sign-in there is no profile, so the subject is the client address — and
 * that is the one case where a shared office connection is the right thing to
 * limit, because it is also what an attacker is coming from.
 *
 * The address is read from the proxy's forwarded headers, which is spoofable
 * by anyone talking to the origin directly. It is used *only* for
 * pre-authentication limits, and the sign-in limiter additionally counts
 * against the identifier being tried, so forging the header moves an attacker
 * from one bucket to another without widening the budget on any account.
 *
 * ## Failure
 *
 * Documented, and different for reads and writes. See `onStoreFailure` below.
 */

export type RateLimitedAction =
  | 'auth.sign-in'
  | 'auth.password-change'
  | 'users.create'
  | 'users.reset-password'
  | 'payments.create'
  | 'payments.reverse'
  | 'loans.approve'
  | 'loans.disburse'
  | 'finance.transfer'
  | 'finance.transfer_decision'
  | 'finance.expense'
  | 'finance.expense_decision'
  | 'finance.income'
  | 'finance.reconciliation'
  | 'finance.reconciliation_decision'
  | 'settings.product'
  | 'settings.update'
  | 'reports.export'
  | 'reports.read'
  | 'uploads.document'
  | 'recovery.record'
  | 'security.collateral'
  | 'security.decision';

export interface RateLimitRule {
  /** Requests permitted inside one window. */
  readonly limit: number;
  readonly windowSeconds: number;
  /**
   * What happens when the counter itself is unreachable.
   *
   * `'closed'` refuses the request. Chosen for the paths where an unlimited
   * attempt is worse than an outage: password guessing, and account creation.
   *
   * `'open'` lets it through. Chosen for ordinary work, including recording a
   * payment — a database that cannot count is a database that cannot post a
   * payment either, so refusing here would add nothing except a second,
   * confusing failure on top of the real one.
   */
  readonly onStoreFailure: 'open' | 'closed';
  /** Shown to the person. Never names the limit's internals. */
  readonly message: string;
}

/**
 * The policy.
 *
 * Numbers chosen from the work, not from a round figure:
 *
 *   - **Sign-in** — 8 in 5 minutes. A person who has genuinely forgotten
 *     which of two passwords it is needs three or four; a script needs
 *     thousands.
 *   - **Password change** — 5 in 15 minutes, because the form asks for the
 *     current password and is therefore also a guessing oracle.
 *   - **Recording a payment** — 60 a minute. A cashier taking a payment every
 *     second for a full minute is working faster than anyone does; a loop is
 *     faster still. `post_payment` is idempotent, so this is a brake on
 *     volume, not the protection against a double tap.
 *   - **Reversal, approval, disbursement** — 20 an hour. These are decisions,
 *     not throughput. Twenty in an hour is already an unusual day.
 *   - **Exports** — 10 in 10 minutes. A CSV of the whole register is the most
 *     expensive thing this system does and the most useful thing to steal.
 *   - **Report reads** — 120 a minute, which no human reaches and a scraper
 *     does immediately.
 *   - **Uploads** — 20 in 10 minutes, matched to registering a client with a
 *     photograph and an identity document.
 *   - **Recovery actions** — 120 in 10 minutes. A collections officer working
 *     a list of overdue loans records one every few seconds for an hour, and
 *     an append-only table means a mis-click cannot be tidied away, so the
 *     limit has to sit above a genuinely busy morning rather than at it.
 *   - **Recording security** — 30 a minute, the rhythm of taking in a pile of
 *     items against one application.
 *   - **Releasing or realising** — 20 an hour, and closed. These are the two
 *     decisions in Phase 14 that let somebody out of a liability or dispose of
 *     an asset, which puts them with reversal and approval rather than with
 *     ordinary work.
 */
export const LIMITS: Readonly<Record<RateLimitedAction, RateLimitRule>> = {
  'auth.sign-in': {
    limit: 8,
    windowSeconds: 300,
    onStoreFailure: 'closed',
    message: 'Too many sign-in attempts. Wait a few minutes and try again.',
  },
  'auth.password-change': {
    limit: 5,
    windowSeconds: 900,
    onStoreFailure: 'closed',
    message: 'Too many password attempts. Wait a few minutes and try again.',
  },
  'users.create': {
    limit: 10,
    windowSeconds: 3600,
    onStoreFailure: 'closed',
    message: 'Too many accounts created just now. Try again shortly.',
  },
  'users.reset-password': {
    limit: 10,
    windowSeconds: 3600,
    onStoreFailure: 'closed',
    message: 'Too many password resets just now. Try again shortly.',
  },
  'payments.create': {
    limit: 60,
    windowSeconds: 60,
    onStoreFailure: 'open',
    message: 'Payments are being recorded faster than expected. Try again in a moment.',
  },
  'payments.reverse': {
    limit: 20,
    windowSeconds: 3600,
    onStoreFailure: 'closed',
    message: 'Too many reversals in the last hour. Try again shortly.',
  },
  // Phase 14. Recording the chase is ordinary work; letting a guarantor out or
  // selling an item is a decision.
  'recovery.record': {
    limit: 120,
    windowSeconds: 600,
    onStoreFailure: 'open',
    message:
      'Recovery actions are being recorded faster than expected. Try again in a moment.',
  },
  'security.collateral': {
    limit: 30,
    windowSeconds: 60,
    onStoreFailure: 'open',
    message: 'Security is being recorded faster than expected. Try again in a moment.',
  },
  'security.decision': {
    limit: 20,
    windowSeconds: 3600,
    onStoreFailure: 'closed',
    message: 'Too many release decisions in the last hour. Try again shortly.',
  },
  'loans.approve': {
    limit: 20,
    windowSeconds: 3600,
    onStoreFailure: 'open',
    message: 'Too many approvals in the last hour. Try again shortly.',
  },
  'loans.disburse': {
    limit: 20,
    windowSeconds: 3600,
    onStoreFailure: 'closed',
    message: 'Too many disbursements in the last hour. Try again shortly.',
  },
  // Phase 11. Recording a movement is ordinary work and fails open, for the
  // reason payments do: a counter that cannot count usually means a database
  // that cannot post either, and a second confusing failure helps nobody.
  // Deciding about one is a decision rather than throughput, so it is slower
  // and fails closed — the same shape as a reversal or an approval.
  'finance.transfer': {
    limit: 30,
    windowSeconds: 60,
    onStoreFailure: 'open',
    message: 'Transfers are being recorded faster than expected. Try again in a moment.',
  },
  'finance.transfer_decision': {
    limit: 20,
    windowSeconds: 3600,
    onStoreFailure: 'closed',
    message: 'Too many transfer decisions in the last hour. Try again shortly.',
  },
  'finance.expense': {
    limit: 30,
    windowSeconds: 60,
    onStoreFailure: 'open',
    message: 'Expenses are being recorded faster than expected. Try again in a moment.',
  },
  'finance.expense_decision': {
    limit: 20,
    windowSeconds: 3600,
    onStoreFailure: 'closed',
    message: 'Too many expense decisions in the last hour. Try again shortly.',
  },
  'finance.income': {
    limit: 60,
    windowSeconds: 60,
    onStoreFailure: 'open',
    message: 'Income is being recorded faster than expected. Try again in a moment.',
  },
  'finance.reconciliation': {
    limit: 20,
    windowSeconds: 600,
    onStoreFailure: 'open',
    message: 'Too many counts just now. Try again in a few minutes.',
  },
  'finance.reconciliation_decision': {
    limit: 20,
    windowSeconds: 3600,
    onStoreFailure: 'closed',
    message: 'Too many reconciliation decisions in the last hour. Try again shortly.',
  },
  // Phase 12. Changing a product changes the rate the business lends at, so
  // this is a decision rather than throughput: slow, and failing closed. A
  // counter that cannot count must not become a way to reprice the business
  // unobserved.
  // Phase 12. The company's identity, the lending rules and the finance
  // thresholds. Same shape as a product change and for the same reason: each
  // is a decision about how the business operates, not throughput.
  'settings.update': {
    limit: 30,
    windowSeconds: 3600,
    onStoreFailure: 'closed',
    message: 'Too many settings changes in the last hour. Try again shortly.',
  },
  'settings.product': {
    limit: 30,
    windowSeconds: 3600,
    onStoreFailure: 'closed',
    message: 'Too many product changes in the last hour. Try again shortly.',
  },
  'reports.export': {
    limit: 10,
    windowSeconds: 600,
    onStoreFailure: 'open',
    message: 'Too many downloads just now. Try again in a few minutes.',
  },
  'reports.read': {
    limit: 120,
    windowSeconds: 60,
    onStoreFailure: 'open',
    message: 'Too many report requests just now. Try again in a moment.',
  },
  'uploads.document': {
    limit: 20,
    windowSeconds: 600,
    onStoreFailure: 'open',
    message: 'Too many uploads just now. Try again in a few minutes.',
  },
};

export interface RateLimitVerdict {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
  readonly message: string;
}

/**
 * The address this request appears to come from.
 *
 * Only ever used for a caller with no session. The headers are set by
 * whatever sits in front of the application and are not trustworthy on their
 * own — which is why `checkRateLimit` takes an explicit `subject` and the
 * sign-in path passes the identifier being tried as well.
 */
export async function clientAddress(): Promise<string> {
  const headerList = await headers();

  const forwarded = headerList.get('x-forwarded-for');
  if (forwarded !== null && forwarded.trim() !== '') {
    // Left-most entry is the original client where the chain is trusted.
    const first = forwarded.split(',')[0]?.trim();
    if (first !== undefined && first !== '') return first;
  }

  return headerList.get('x-real-ip')?.trim() ?? 'unknown';
}

/**
 * Hash the bucket, so the stored key identifies nobody.
 *
 * A dump of `rate_limit_counters` should say that some action was limited and
 * nothing else — not which phone number somebody was trying, and not which
 * staff member is near their export quota.
 */
function bucketKey(action: RateLimitedAction, subject: string): string {
  return createHash('sha256').update(`${action}\u0000${subject}`).digest('hex');
}

/**
 * Consume one unit of an action's budget.
 *
 * Returns a verdict rather than throwing, so the caller decides what a refusal
 * looks like — a form shows it as a message, a route returns 429 with
 * `Retry-After`. Neither reveals the limit or the window: "wait a few minutes"
 * tells a person what to do without telling a script how fast it may go.
 */
export async function checkRateLimit(
  action: RateLimitedAction,
  subject: string,
  options: {
    /**
     * True for a caller who has no session yet — sign-in, in practice.
     *
     * `consume_rate_limit` is granted to `authenticated` and `service_role`
     * and deliberately **not** to `anon`. If an anonymous browser could call
     * it, anyone could exhaust a chosen account's sign-in budget and lock
     * that person out, which turns a defence into a denial of service. So the
     * pre-authentication limiter runs through the privileged client, which is
     * used here to *count* and for nothing else: it reads no data, writes no
     * record, and the verdict it returns cannot widen anyone's access.
     */
    readonly preAuthenticated?: boolean;
  } = {},
): Promise<RateLimitVerdict> {
  const rule = LIMITS[action];

  try {
    const supabase =
      options.preAuthenticated === true
        ? createSupabaseAdminClient('rate limiting a caller who has no session yet')
        : await createSupabaseServerClient();

    const { data, error } = await supabase.rpc('consume_rate_limit', {
      p_bucket_key: bucketKey(action, subject),
      p_action: action,
      p_limit: rule.limit,
      p_window_seconds: rule.windowSeconds,
    });

    if (error !== null) throw error;

    const row = Array.isArray(data) ? data[0] : data;

    if (row === undefined || row === null) {
      return storeFailed(action, rule, 'The limiter returned no verdict.');
    }

    const allowed = Boolean(row.allowed);

    if (!allowed) {
      // A refusal is an operational event worth seeing. The subject is never
      // logged — the hash is not reversible and the raw subject is a phone
      // number or an address.
      logger.warn('A request was rate limited.', {
        action,
        retryAfterSeconds: Number(row.retry_after_seconds ?? 0),
      });
    }

    return {
      allowed,
      remaining: Number(row.remaining ?? 0),
      retryAfterSeconds: Number(row.retry_after_seconds ?? 0),
      message: rule.message,
    };
  } catch (error) {
    return storeFailed(action, rule, describeLimiterFailure(error));
  }
}

/**
 * What to put in the log when the limiter could not be consulted.
 *
 * A `PostgrestError` is a plain object, not an `Error`, so a bare
 * `instanceof Error` check reduced every database-side refusal to "Unknown
 * limiter failure" — which is how a misconfigured API key once presented
 * itself as an unexplained outage on the sign-in form. The code and the hint
 * are the two fields that say which it was; the message is quoted as it
 * arrives, and nothing here is shown to the person.
 */
function describeLimiterFailure(error: unknown): string {
  if (error instanceof Error) return error.message;

  if (typeof error === 'object' && error !== null) {
    const candidate = error as {
      message?: unknown;
      code?: unknown;
      hint?: unknown;
      details?: unknown;
    };

    const parts = [
      typeof candidate.code === 'string' ? `[${candidate.code}]` : null,
      typeof candidate.message === 'string' ? candidate.message : null,
      typeof candidate.details === 'string' ? candidate.details : null,
      typeof candidate.hint === 'string' ? candidate.hint : null,
    ].filter((part): part is string => part !== null && part !== '');

    if (parts.length > 0) return parts.join(' ');
  }

  // Nothing recognisable. Say what arrived rather than "unknown": the
  // constructor name alone has twice been enough to find the cause.
  const shape =
    typeof error === 'object' && error !== null
      ? `${error.constructor?.name ?? 'object'} {${Object.keys(error).join(',')}}`
      : typeof error;

  return `Unrecognised limiter failure (${shape}).`;
}

function storeFailed(
  action: RateLimitedAction,
  rule: RateLimitRule,
  reason: string,
): RateLimitVerdict {
  logger.error('The rate limiter could not be consulted.', {
    action,
    stance: rule.onStoreFailure,
    reason,
  });

  if (rule.onStoreFailure === 'open') {
    return {
      allowed: true,
      remaining: 0,
      retryAfterSeconds: 0,
      message: rule.message,
    };
  }

  return {
    allowed: false,
    remaining: 0,
    retryAfterSeconds: 60,
    message:
      'This action is temporarily unavailable. Try again shortly, and tell your administrator if it continues.',
  };
}

/**
 * The response headers that accompany a refusal.
 *
 * `Retry-After` is the one piece of information a caller legitimately needs.
 * The limit and the remaining budget are deliberately not published: they let
 * a script pace itself to stay just inside the policy.
 */
export function rateLimitHeaders(verdict: RateLimitVerdict): Record<string, string> {
  return { 'Retry-After': String(Math.max(verdict.retryAfterSeconds, 1)) };
}

/**
 * The common case: a signed-in person doing a thing they are allowed to do.
 *
 * Keyed on the profile rather than the address, because a lending office
 * shares one internet connection — limiting by address would mean the second
 * cashier of the morning is throttled by the first one's work. The profile is
 * resolved from the session and cannot be supplied by the caller, so there is
 * nothing here to forge.
 *
 * Returns the verdict rather than throwing, so a form can show the message
 * where the person is looking instead of replacing the page with an error.
 */
export async function checkActorRateLimit(
  action: RateLimitedAction,
  profileId: string,
): Promise<RateLimitVerdict> {
  return await checkRateLimit(action, `profile:${profileId}`);
}
