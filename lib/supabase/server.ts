/**
 * Server Supabase client, for Server Components, Server Actions and Route
 * Handlers.
 *
 * Still the **publishable** key, not the secret one. That is deliberate: the
 * client reads the user's session from the request cookies and acts as that
 * user, so Row Level Security applies exactly as it does in the browser. A
 * server context is not a reason to escalate privileges.
 *
 * A fresh client is created per request. It must not be hoisted into a module
 * constant — on a serverless platform a module-scope client would be reused
 * across requests and would serve one user's data to another.
 */

import 'server-only';

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

import { getPublicEnv, isProduction } from '@/lib/env.public';
import { hardenSessionCookie } from '@/lib/security/session-cookie';
import type { Database } from '@/types/database.types';

/**
 * A typed Supabase client scoped to the current request's session.
 *
 * Call it inside the request; never cache the result beyond it.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  const env = getPublicEnv();

  return createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet, _headers) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(
                name,
                value,
                hardenSessionCookie(options, { secure: isProduction() }),
              );
            }
          } catch {
            // A Server Component cannot write cookies. This is expected and
            // safe to ignore: the proxy (proxy.ts) refreshes the session on
            // every request and writes the cookies there, including the cache
            // headers that stop a CDN from caching one user's session.
          }
        },
      },
    },
  );
}
