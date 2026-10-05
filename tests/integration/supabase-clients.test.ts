import { existsSync, globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigurationError } from '@/lib/errors';
import { getPublicEnv, resetPublicEnvCache } from '@/lib/env.public';

/**
 * The Supabase client architecture.
 *
 * Three claims: there is no browser client and there must not be one, the
 * privileged client cannot be reached from client code, and the public
 * environment is validated before any client is built from it.
 */

const KEYS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
] as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  resetPublicEnvCache();
});

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetPublicEnvCache();
});

describe('there is no browser client', () => {
  it('the module is gone, and that is load-bearing', () => {
    // `lib/supabase/client.ts` was removed in Phase 9, and not as tidying.
    // The session cookie is now written `HttpOnly` (see
    // `lib/security/session-cookie.ts`), which a browser Supabase client
    // cannot work with: `createBrowserClient` reads the session out of
    // `document.cookie`, would find nothing, and would sign the user out on
    // the first render. Every read and write in this application is a Server
    // Component or a Server Action, so nothing wanted one — but a module
    // sitting there invites the import that would break authentication in a
    // way no unit test would notice.
    expect(existsSync(join(process.cwd(), 'lib/supabase/client.ts'))).toBe(false);
  });

  it('nothing in the application creates one', () => {
    const files = globSync('{app,components,lib,hooks}/**/*.{ts,tsx}', {
      cwd: process.cwd(),
    });

    expect(files.length).toBeGreaterThan(50);

    for (const file of files) {
      expect(
        readFileSync(join(process.cwd(), file), 'utf8'),
        `${file} creates a browser Supabase client`,
      ).not.toContain('createBrowserClient');
    }
  });
});

describe('the public environment guard', () => {
  // These three assertions used to be made through the browser client, which
  // was the only caller that reached them. The guard itself lives in
  // `getPublicEnv`, and it is what the server client and the proxy depend on
  // too — so it is asserted where it lives rather than through a module that
  // no longer exists.

  it('fails clearly when Supabase is not configured', () => {
    // Better a loud configuration error than a client pointed at nothing.
    expect(() => getPublicEnv()).toThrow(ConfigurationError);
  });

  it('accepts valid configuration', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefghijklmnop.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test123';
    resetPublicEnvCache();

    const env = getPublicEnv();

    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe('https://abcdefghijklmnop.supabase.co');
    expect(env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY).toBe('sb_publishable_test123');
  });

  it('refuses a secret key supplied as the publishable key', () => {
    // The worst available misconfiguration: this key bypasses Row Level
    // Security, and a NEXT_PUBLIC_ value is inlined into every browser bundle.
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefghijklmnop.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_secret_dangerous';
    resetPublicEnvCache();

    expect(() => getPublicEnv()).toThrow(/expose it to every browser/);
  });
});

describe('privileged client is unreachable from client code', () => {
  it('cannot be imported outside a Server Component context', async () => {
    // `lib/supabase/admin.ts` holds the secret key, which bypasses Row Level
    // Security. Its first statement is `import 'server-only'`, and this test
    // asserts that guard actually bites: the import fails rather than
    // succeeding and shipping the module into a client bundle.
    //
    // This environment is jsdom, which resolves `server-only` the same way a
    // Client Component build does.
    await expect(import('@/lib/supabase/admin')).rejects.toThrow(
      /cannot be imported from a Client Component/,
    );
  });

  it('applies the same guard to the server-only environment module', async () => {
    await expect(import('@/lib/env.server')).rejects.toThrow(
      /cannot be imported from a Client Component/,
    );
  });
});
