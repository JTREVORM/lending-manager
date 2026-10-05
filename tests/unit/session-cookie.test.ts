import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { hardenSessionCookie } from '@/lib/security/session-cookie';

/**
 * How the session cookie is written.
 *
 * The end-to-end suite asserts the observable half — that `document.cookie`
 * in a signed-in browser contains no session. This asserts the options that
 * produce it, including the ones a browser cannot report back.
 */

describe('hardening the session cookie', () => {
  it('is HttpOnly, always', () => {
    // `@supabase/ssr` omits this because its browser client reads the session
    // from `document.cookie`. This application has no browser client: every
    // read and write is a Server Component or a Server Action, so the
    // privilege is one nothing uses — and one an injected script would.
    expect(hardenSessionCookie(undefined, { secure: false }).httpOnly).toBe(true);
    expect(hardenSessionCookie({ httpOnly: false }, { secure: false }).httpOnly).toBe(
      true,
    );
  });

  it('refuses to travel on a cross-site request', () => {
    // What makes a forged cross-site POST to a Server Action arrive
    // unauthenticated. `'strict'` would also drop the session when staff
    // follow a link into the application from a message, which they do.
    expect(hardenSessionCookie(undefined, { secure: false }).sameSite).toBe('lax');
  });

  it('keeps a stricter sameSite that Supabase itself chose', () => {
    expect(hardenSessionCookie({ sameSite: 'strict' }, { secure: false }).sameSite).toBe(
      'strict',
    );
  });

  it('is Secure in production and not in development', () => {
    // A `Secure` cookie is never stored over the dev server's plain HTTP, so
    // forcing it unconditionally would sign nobody in locally.
    expect(hardenSessionCookie(undefined, { secure: true }).secure).toBe(true);
    expect(hardenSessionCookie(undefined, { secure: false }).secure).toBe(false);
  });

  it('never downgrades a Secure cookie Supabase already marked', () => {
    expect(hardenSessionCookie({ secure: true }, { secure: false }).secure).toBe(true);
  });

  it('covers the whole application', () => {
    expect(hardenSessionCookie(undefined, { secure: false }).path).toBe('/');
    expect(hardenSessionCookie({ path: '/portal' }, { secure: false }).path).toBe(
      '/portal',
    );
  });

  it('preserves everything else Supabase specified', () => {
    const hardened = hardenSessionCookie(
      { maxAge: 3600, domain: 'example.test' },
      { secure: true },
    );

    expect(hardened.maxAge).toBe(3600);
    expect(hardened.domain).toBe('example.test');
  });
});

describe('the browser never gets a Supabase client', () => {
  it('no module creates one', () => {
    // The invariant that makes `HttpOnly` safe. A browser client would read
    // the session from `document.cookie`, find nothing, and sign the user out
    // on the first render — so the absence of one is load-bearing, not tidy.
    const files = globSync('{app,components,lib,hooks}/**/*.{ts,tsx}', {
      cwd: process.cwd(),
    });

    expect(files.length).toBeGreaterThan(50);

    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      expect(source, `${file} creates a browser Supabase client`).not.toContain(
        'createBrowserClient',
      );
    }
  });
});
