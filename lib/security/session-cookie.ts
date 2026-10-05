import type { CookieOptions } from '@supabase/ssr';

/**
 * How this application writes a session cookie.
 *
 * ## Why `httpOnly`
 *
 * `@supabase/ssr` writes the session without `HttpOnly` by default, and it has
 * to: its *browser* client reads the session out of `document.cookie`. This
 * application has no browser client. Every read and every write goes through a
 * Server Component or a Server Action, the session is read on the server from
 * the request, and nothing in the bundle ever asks for it.
 *
 * So the default is a privilege nothing uses. Removing it matters here more
 * than it would elsewhere: the machine on the counter is shared, it is used by
 * several people a day, and a single injected script that can read
 * `document.cookie` walks away with a session that posts payments. The policy
 * in `headers.ts` is what stops that script running; this is what it would
 * find if one ever did.
 *
 * The end-to-end suite asserts it from the browser's own `document.cookie`,
 * which is where the absence is observable and where its presence was found.
 *
 * ## Why the other three
 *
 *   - `sameSite: 'lax'` — a cross-site POST must not carry the session, which
 *     is what makes a CSRF attempt against a Server Action arrive
 *     unauthenticated. `'strict'` would also break following a link into the
 *     application from a message, which staff do.
 *   - `secure` — in production the cookie travels only over TLS. Not set in
 *     development, where the dev server is plain HTTP and a `Secure` cookie
 *     would simply never be stored.
 *   - `path: '/'` — one session for the whole application, rather than one per
 *     subtree that silently fails to be sent.
 *
 * Anything Supabase itself specifies (`maxAge`, the chunked-cookie names) is
 * preserved: this hardens the options it chose, it does not replace them.
 */
export function hardenSessionCookie(
  options: CookieOptions | undefined,
  { secure }: { readonly secure: boolean },
): CookieOptions {
  return {
    ...options,
    httpOnly: true,
    sameSite: options?.sameSite ?? 'lax',
    secure: secure || (options?.secure ?? false),
    path: options?.path ?? '/',
  };
}
