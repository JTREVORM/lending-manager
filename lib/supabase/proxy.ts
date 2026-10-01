/**
 * Session refresh for the Next.js proxy (what earlier versions called
 * middleware).
 *
 * Supabase access tokens are short-lived. A Server Component cannot write
 * cookies, so something has to run before the request reaches one, refresh the
 * token if needed, and hand the new value to both the server and the browser.
 * That is this function's entire job.
 *
 * ## What it deliberately does NOT do
 *
 * It does not redirect anonymous visitors, and it does not protect any route.
 * Route protection is Phase 2, and implementing it here before the
 * authentication flows exist would mean a half-built guard — the worst kind,
 * because it looks like protection. Phase 2 adds the redirect, and the real
 * boundary stays Row Level Security in the database.
 *
 * ## Cache headers
 *
 * `setAll` receives cache headers alongside the cookies, and they are applied
 * to the response. Without them, a CDN or ISR layer can cache a response that
 * carries a `Set-Cookie` for a refreshed session and serve it to a different
 * visitor — who would then be signed in as somebody else. In a lending system
 * that is a catastrophic failure, so the headers are not optional.
 */

import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import { getPublicEnv } from '@/lib/env.public';
import type { Database } from '@/types/database.types';

export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const env = getPublicEnv();

  // Created per request. With fluid or serverless compute, a module-scope
  // client would leak one visitor's session into another's request.
  const supabase = createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }

          response = NextResponse.next({ request });

          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }

          // Cache-Control / Expires / Pragma, which stop an intermediary from
          // caching this response and leaking the session.
          for (const [key, value] of Object.entries(headers)) {
            response.headers.set(key, value);
          }
        },
      },
    },
  );

  // Nothing may run between creating the client and this call: it is what
  // triggers the refresh and writes the cookies.
  //
  // `getClaims()` verifies the JWT signature against the project's published
  // keys on every call. `getSession()` does not, so it must never be trusted
  // on the server — a cookie is attacker-controlled input.
  await supabase.auth.getClaims();

  // The response object must be returned as-is. Constructing a different
  // response without copying these cookies across would desynchronise the
  // browser and the server and sign users out at random.
  return response;
}
