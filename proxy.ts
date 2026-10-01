/**
 * Next.js proxy (formerly middleware).
 *
 * Runs before every matched request, solely to keep the Supabase session
 * fresh. See lib/supabase/proxy.ts for why that has to happen here, and for
 * what is deliberately left to Phase 2.
 */

import { type NextRequest } from 'next/server';

import { updateSession } from '@/lib/supabase/proxy';

export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and image files, which have no session
     * to refresh and would only add latency.
     */
    '/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
