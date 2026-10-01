import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigurationError } from '@/lib/errors';
import { resetPublicEnvCache } from '@/lib/env.public';

/**
 * The Supabase client architecture.
 *
 * Phase 1 does not yet read data from a Client Component or perform any
 * privileged operation, so neither of these modules has a caller. They are
 * part of the required client architecture and are covered here so that they
 * are verified code rather than untested scaffolding.
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

describe('browser client', () => {
  it('fails clearly when Supabase is not configured', async () => {
    const { createSupabaseBrowserClient } = await import('@/lib/supabase/client');

    // Better a loud configuration error than a client pointed at nothing.
    expect(() => createSupabaseBrowserClient()).toThrow(ConfigurationError);
  });

  it('constructs a usable client from valid configuration', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefghijklmnop.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test123';
    resetPublicEnvCache();

    const { createSupabaseBrowserClient } = await import('@/lib/supabase/client');
    const supabase = createSupabaseBrowserClient();

    expect(supabase).toHaveProperty('from');
    expect(supabase).toHaveProperty('auth');

    // Building a typed query must not throw. It is lazy — nothing is sent
    // until the builder is awaited — so this makes no network call.
    expect(() => supabase.from('roles').select('key')).not.toThrow();
  });

  it('refuses a secret key supplied as the publishable key', async () => {
    // The worst available misconfiguration: this key bypasses Row Level
    // Security and a NEXT_PUBLIC_ value is inlined into every browser bundle.
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefghijklmnop.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_secret_dangerous';
    resetPublicEnvCache();

    const { createSupabaseBrowserClient } = await import('@/lib/supabase/client');

    expect(() => createSupabaseBrowserClient()).toThrow(/expose it to every browser/);
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
