/**
 * Privileged Supabase client — the secret key, which BYPASSES Row Level
 * Security.
 *
 * ## Read this before using it
 *
 * This client is **not** a convenience for when RLS is inconvenient. Using it
 * to read data a user is not entitled to, or to write data they are not
 * permitted to write, silently removes the only real security boundary in the
 * system. If a query fails under RLS, the fix is a correct policy, not this
 * module.
 *
 * Legitimate uses are operations that have no user context at all and are
 * authorised by something other than a session:
 *
 *   - a scheduled job (applying penalties after the grace period, a later
 *     phase) that runs on behalf of the business rather than a person;
 *   - creating the very first `owner_admin`, when no one exists yet to
 *     authorise it;
 *   - an administrative repair performed by a developer with explicit
 *     approval.
 *
 * In every case, the caller must have already established that the operation
 * is permitted. This module provides no authorization of its own.
 *
 * ## Phase 1
 *
 * Nothing in Phase 1 uses it. It exists as a deliberate seam so that later
 * phases have one reviewable place where privilege is escalated, rather than
 * ad-hoc secret-key clients appearing across the codebase. `SUPABASE_SECRET_KEY`
 * is optional, and if it is unset this throws a clear configuration error
 * instead of falling back to a less privileged client — a silent downgrade
 * would be worse than a loud failure.
 *
 * Three independent guards keep it off the client: the `server-only` import
 * (build-time), the ESLint `no-restricted-imports` rule (lint-time), and
 * `assertServerOnly` (runtime).
 */

import 'server-only';

import { createClient } from '@supabase/supabase-js';

import { getPublicEnv } from '@/lib/env.public';
import { requireSupabaseSecretKey } from '@/lib/env.server';
import { assertServerOnly } from '@/lib/utils/server-guard';
import type { Database } from '@/types/database.types';

/**
 * Construct a privileged client.
 *
 * @param reason Why privilege is needed. Required, and recorded at the call
 *   site, so a reviewer reading the diff can see the justification without
 *   reconstructing it.
 * @throws ConfigurationError if called in a browser, or if the secret key is
 *   not configured.
 */
export function createSupabaseAdminClient(reason: string) {
  assertServerOnly(`Privileged Supabase client (${reason})`);

  const env = getPublicEnv();
  const secretKey = requireSupabaseSecretKey();

  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, secretKey, {
    auth: {
      // No session to persist or refresh: this client is not a user.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
