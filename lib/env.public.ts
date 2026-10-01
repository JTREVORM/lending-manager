/**
 * Browser-safe environment configuration.
 *
 * Everything here is inlined into the client bundle by Next.js, so it must
 * contain nothing secret. The publishable Supabase key belongs in this file by
 * design: it grants no privileges of its own and all access is decided by Row
 * Level Security. The *secret* key is read in `lib/env.server.ts`, which is
 * marked `server-only`.
 *
 * Validation is lazy. `process.env.NEXT_PUBLIC_*` references are replaced at
 * build time, but a missing value must not break `next build` in a CI job that
 * has no credentials — it must fail loudly at the moment the application
 * actually tries to reach Supabase. `npm run check:env` validates eagerly for
 * deployment pipelines.
 */

import { z } from 'zod';

import { APP_ENVIRONMENTS, type AppEnvironment } from '@/config/app';
import { ConfigurationError } from '@/lib/errors';

const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z
    .string({ error: 'NEXT_PUBLIC_SUPABASE_URL is required.' })
    .min(1, 'NEXT_PUBLIC_SUPABASE_URL is required.')
    .url('NEXT_PUBLIC_SUPABASE_URL must be a full URL, e.g. https://xyz.supabase.co')
    .refine((value) => value.startsWith('https://'), {
      message: 'NEXT_PUBLIC_SUPABASE_URL must use https.',
    }),

  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z
    .string({ error: 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is required.' })
    .min(1, 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is required.')
    .refine((value) => !value.startsWith('sb_secret_'), {
      message:
        'A secret key (sb_secret_...) was supplied as the publishable key. This would expose it to every browser. Use the publishable key instead.',
    }),

  NEXT_PUBLIC_APP_ENV: z.enum(APP_ENVIRONMENTS).default('development'),

  NEXT_PUBLIC_SITE_URL: z.string().url().optional(),
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;

/**
 * Raw values, listed explicitly so Next.js can statically replace each one.
 * A dynamic `process.env[name]` lookup would not be inlined in the browser.
 */
function readRawPublicEnv(): Record<string, string | undefined> {
  return {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_APP_ENV: process.env.NEXT_PUBLIC_APP_ENV,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  };
}

/** Drop empty strings so `.optional()` and `.default()` behave as intended. */
function withoutBlanks(
  raw: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined && value.trim() !== '') result[key] = value;
  }
  return result;
}

let cached: PublicEnv | undefined;

/**
 * Validated public environment.
 *
 * @throws ConfigurationError listing every missing or malformed variable.
 */
export function getPublicEnv(): PublicEnv {
  if (cached !== undefined) return cached;

  const parsed = publicEnvSchema.safeParse(withoutBlanks(readRawPublicEnv()));

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    throw new ConfigurationError(
      `Invalid public environment configuration:\n${problems}\n\nCopy .env.example to .env.local and fill in the values.`,
    );
  }

  cached = parsed.data;
  return cached;
}

/**
 * Validate without throwing. Used by `npm run check:env` and by UI that wants
 * to explain a misconfiguration rather than crash.
 */
export function inspectPublicEnv():
  | { readonly ok: true; readonly env: PublicEnv }
  | { readonly ok: false; readonly problems: readonly string[] } {
  const parsed = publicEnvSchema.safeParse(withoutBlanks(readRawPublicEnv()));

  if (parsed.success) return { ok: true, env: parsed.data };

  return {
    ok: false,
    problems: parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    ),
  };
}

/** Deployment environment, defaulting to `development` when unset. */
export function getAppEnvironment(): AppEnvironment {
  const raw = process.env.NEXT_PUBLIC_APP_ENV?.trim();
  return (APP_ENVIRONMENTS as readonly string[]).includes(raw ?? '')
    ? (raw as AppEnvironment)
    : 'development';
}

export function isProduction(): boolean {
  return getAppEnvironment() === 'production';
}

/** Reset the memoised value. Test-only. */
export function resetPublicEnvCache(): void {
  cached = undefined;
}
