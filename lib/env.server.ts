/**
 * Server-only environment configuration.
 *
 * The `server-only` import makes Next.js fail the build if any Client
 * Component pulls this module into the browser bundle. That is the primary
 * guard that keeps `SUPABASE_SECRET_KEY` server-side; the ESLint
 * `no-restricted-imports` rule is a faster, friendlier second line.
 *
 * Phase 1 does not require any secret to run. `SUPABASE_SECRET_KEY` is
 * optional and, when absent, the privileged client in `lib/supabase/admin.ts`
 * simply refuses to be constructed. Nothing silently degrades to a less secure
 * path.
 */

import 'server-only';

import { z } from 'zod';

import { LOG_LEVELS } from '@/config/app';
import { ConfigurationError } from '@/lib/errors';

const serverEnvSchema = z.object({
  /**
   * Supabase secret key ("sb_secret_..."), formerly the `service_role` key.
   * It BYPASSES Row Level Security, so it is optional, never required to boot,
   * and must only be used by operations that genuinely need to act outside any
   * user's permissions. It is never a shortcut around an authorization check.
   */
  SUPABASE_SECRET_KEY: z
    .string()
    .min(1)
    .refine((value) => !value.startsWith('sb_publishable_'), {
      message:
        'A publishable key was supplied as SUPABASE_SECRET_KEY. The privileged client needs the secret key.',
    })
    .optional(),

  /**
   * Direct PostgreSQL connection string, used only by local developer tooling
   * (migration verification, database integration tests). The running
   * application never opens a direct connection — it goes through Supabase.
   */
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((value) => /^postgres(ql)?:\/\//.test(value), {
      message: 'DATABASE_URL must be a postgres:// or postgresql:// URL.',
    })
    .optional(),

  LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

function readRawServerEnv(): Record<string, string | undefined> {
  const raw: Record<string, string | undefined> = {
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
    DATABASE_URL: process.env.DATABASE_URL,
    LOG_LEVEL: process.env.LOG_LEVEL,
  };

  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined && value.trim() !== '') result[key] = value;
  }
  return result;
}

let cached: ServerEnv | undefined;

/**
 * Validated server environment.
 *
 * @throws ConfigurationError if a supplied value is malformed. Absent optional
 *   values are not an error here — the consumer that needs one says so.
 */
export function getServerEnv(): ServerEnv {
  if (cached !== undefined) return cached;

  const parsed = serverEnvSchema.safeParse(readRawServerEnv());

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    // The message names variables and states what is wrong with them. It never
    // echoes a value, so a stack trace in a log cannot leak the key itself.
    throw new ConfigurationError(
      `Invalid server environment configuration:\n${problems}`,
    );
  }

  cached = parsed.data;
  return cached;
}

/**
 * The Supabase secret key, or a clear failure.
 *
 * Call this only from code that has already established the caller is allowed
 * to perform a privileged operation.
 *
 * @throws ConfigurationError when the key is not configured.
 */
export function requireSupabaseSecretKey(): string {
  const key = getServerEnv().SUPABASE_SECRET_KEY;

  if (key === undefined) {
    throw new ConfigurationError(
      "SUPABASE_SECRET_KEY is not configured. This operation requires the privileged Supabase client. Set it in .env.local (never commit it) or in your host's secret store.",
    );
  }

  return key;
}

/** Reset the memoised value. Test-only. */
export function resetServerEnvCache(): void {
  cached = undefined;
}
