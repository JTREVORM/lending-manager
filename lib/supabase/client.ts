/**
 * Browser Supabase client.
 *
 * Uses the publishable key, which carries no privileges of its own — every
 * read and write is decided by Row Level Security against the signed-in user's
 * JWT. Safe to use from Client Components.
 *
 * `createBrowserClient` is internally a singleton, so calling this per
 * component is cheap and does not create duplicate auth listeners.
 */

import { createBrowserClient } from '@supabase/ssr';

import { getPublicEnv } from '@/lib/env.public';
import type { Database } from '@/types/database.types';

/** A typed Supabase client for the browser. */
export function createSupabaseBrowserClient() {
  const env = getPublicEnv();

  return createBrowserClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  );
}
