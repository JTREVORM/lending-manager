/**
 * Session refresh for the Next.js proxy (what earlier versions called
 * middleware).
 *
 * Supabase access tokens are short-lived. A Server Component cannot write
 * cookies, so something has to run before the request reaches one, refresh the
 * token if needed, and hand the new value to both the server and the browser.
 * That is this function's entire job.
 *
 * ## The first of three layers
 *
 * Phase 2 adds a redirect here: a request with no session that is heading for
 * a protected path is sent to the sign-in page before any page code runs. That
 * is cheap — it reads the token and nothing else — and it is what prevents a
 * flash of application chrome before a redirect.
 *
 * It is deliberately NOT where authorization is decided. The token says who
 * signed in; it does not say whether that account is still active or what it
 * may do now. Those questions are answered per request against the database in
 * `lib/auth/context.ts`, and backstopped by Row Level Security. A proxy that
 * tried to answer them would be making a database call on every asset request
 * and would still be guessing from a token that may be an hour old.
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

import { ROUTES } from '@/config/app';
import { isPublicPath } from '@/lib/auth/routing';
import { getPublicEnv } from '@/lib/env.public';
import {
  CSP_NONCE_HEADER,
  PRIVATE_CACHE_HEADERS,
  buildContentSecurityPolicy,
  createCspNonce,
  isPubliclyCacheablePath,
  securityHeaders,
} from '@/lib/security/headers';
import type { Database } from '@/types/database.types';

/**
 * Header carrying the request path through to Server Components.
 *
 * A layout does not receive the pathname, and the route guard needs it in
 * order to look up which capability the route requires. Forwarding it here
 * means the guard runs automatically for every page under the authenticated
 * layout, rather than depending on each page remembering to call it — which is
 * precisely the omission that leaves a route reachable while its menu entry is
 * hidden.
 *
 * It is set from `request.nextUrl.pathname`, which is the framework's own
 * parsed value, not from anything the client sends. Any inbound header of the
 * same name is overwritten below.
 */
export const PATHNAME_HEADER = 'x-lending-pathname';

export async function updateSession(request: NextRequest): Promise<NextResponse> {
  // Overwrite rather than append: a client that sent this header must not be
  // able to make the guard evaluate a different route's requirements.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(PATHNAME_HEADER, request.nextUrl.pathname);

  // One nonce per response, forwarded so the root layout can stamp it onto
  // the scripts Next.js emits, and used below to build this response's
  // Content-Security-Policy. The two must be the same value or no script
  // runs, which is why it is minted here rather than in either place
  // separately.
  const nonce = createCspNonce();
  requestHeaders.set(CSP_NONCE_HEADER, nonce);

  // Next.js finds the nonce by reading the policy off the *request* headers
  // and applies it to the scripts it emits. Without this line the response
  // carries a nonce-based policy that none of the framework's own scripts
  // satisfy, and the application renders a blank page — which is the usual
  // way a CSP gets weakened back to 'unsafe-inline' in a hurry.
  requestHeaders.set('Content-Security-Policy', buildContentSecurityPolicy(nonce));

  const forwarded = { headers: requestHeaders } as const;

  let response = NextResponse.next({ request: forwarded });

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

          response = NextResponse.next({ request: forwarded });

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
  const { data: claims } = await supabase.auth.getClaims();

  const hasSession = typeof claims?.claims.sub === 'string';
  const pathname = request.nextUrl.pathname;

  // Anonymous visitor heading somewhere protected. Redirecting here, rather
  // than from a page, means no protected markup is ever generated.
  if (!hasSession && !isPublicPath(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = ROUTES.login;
    url.search = '';

    // Where they were going, so sign-in can return them there. Only a path
    // from this site is kept — an absolute URL here would make the sign-in
    // page an open redirect, which is a convenient way to make a phishing
    // link look like it came from the lender.
    if (pathname !== ROUTES.dashboard) {
      url.searchParams.set('next', pathname);
    }

    return applyResponsePolicy(request, redirectPreservingCookies(url, response), nonce);
  }

  // Signed in and heading for the sign-in page. Send them into the
  // application; `landingPathFor` cannot be used here because it needs the
  // profile, so the root route decides and redirects onward.
  if (hasSession && isPublicPath(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = ROUTES.dashboard;
    url.search = '';

    return applyResponsePolicy(request, redirectPreservingCookies(url, response), nonce);
  }

  // The response object must be returned as-is. Constructing a different
  // response without copying these cookies across would desynchronise the
  // browser and the server and sign users out at random.
  return applyResponsePolicy(request, response, nonce);
}

/**
 * Stamp the security and cache policy onto a response on its way out.
 *
 * Applied last, so it covers every path through this function — the signed-in
 * page, the redirect to sign-in, and the redirect away from it. A header set
 * only on the happy path is a header that is missing exactly when something
 * has gone wrong.
 *
 * The cache rules deserve their own note. Supabase's session refresh already
 * sets `Cache-Control` when it writes a cookie, and those values are
 * preserved — but it only does so on the responses that *carry* a cookie. A
 * signed-in page that needed no refresh would otherwise go out with whatever
 * Next.js chose, which is how one borrower's balance ends up in a shared
 * cache and then on somebody else's screen. So every path that is not a build
 * asset is marked `no-store` here regardless.
 */
function applyResponsePolicy(
  request: NextRequest,
  response: NextResponse,
  nonce: string,
): NextResponse {
  for (const [name, value] of Object.entries(securityHeaders(nonce))) {
    response.headers.set(name, value);
  }

  // Echoed so a page can read its own nonce without re-deriving it.
  response.headers.set(CSP_NONCE_HEADER, nonce);

  if (!isPubliclyCacheablePath(request.nextUrl.pathname)) {
    for (const [name, value] of Object.entries(PRIVATE_CACHE_HEADERS)) {
      response.headers.set(name, value);
    }
  }

  return response;
}

/**
 * Redirect while keeping whatever the session refresh just wrote.
 *
 * A bare `NextResponse.redirect` would discard the refreshed cookies and the
 * cache headers that came with them, which signs users out at random and —
 * worse — drops the headers that stop an intermediary caching one visitor's
 * `Set-Cookie` and serving it to another.
 */
function redirectPreservingCookies(url: URL, source: NextResponse): NextResponse {
  const redirect = NextResponse.redirect(url);

  for (const cookie of source.cookies.getAll()) {
    redirect.cookies.set(cookie);
  }

  for (const header of ['cache-control', 'expires', 'pragma']) {
    const value = source.headers.get(header);
    if (value !== null) redirect.headers.set(header, value);
  }

  return redirect;
}
