import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getAppEnvironment,
  getPublicEnv,
  inspectPublicEnv,
  isProduction,
  resetPublicEnvCache,
} from '@/lib/env.public';
import { ConfigurationError } from '@/lib/errors';
import { assertServerOnly, isBrowser } from '@/lib/utils/server-guard';

const PUBLIC_KEYS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'NEXT_PUBLIC_APP_ENV',
  'NEXT_PUBLIC_SITE_URL',
] as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of PUBLIC_KEYS) {
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

describe('getPublicEnv', () => {
  it('accepts a valid configuration', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefgh.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_abc123';

    const env = getPublicEnv();
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe('https://abcdefgh.supabase.co');
    expect(env.NEXT_PUBLIC_APP_ENV).toBe('development');
  });

  it('fails clearly, listing every problem at once', () => {
    // A developer should learn everything that is wrong from one message, not
    // fix one variable and rerun to find the next.
    try {
      getPublicEnv();
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const message = (error as ConfigurationError).message;
      expect(message).toContain('NEXT_PUBLIC_SUPABASE_URL');
      expect(message).toContain('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
      expect(message).toContain('.env.example');
    }
  });

  it('refuses a secret key supplied as the publishable key', () => {
    // This is the single worst configuration mistake available: it would ship
    // an RLS-bypassing key to every browser. It must not merely warn.
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefgh.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_secret_dangerous';

    expect(() => getPublicEnv()).toThrow(/expose it to every browser/);
  });

  it('requires https, so credentials are never sent in clear text', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://abcdefgh.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_abc123';

    expect(() => getPublicEnv()).toThrow(/must use https/);
  });

  it('rejects a URL that is not a URL', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'abcdefgh.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_abc123';

    expect(() => getPublicEnv()).toThrow(/full URL/);
  });

  it('treats a blank value as absent, so an empty .env line still fails', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = '   ';
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = '';

    expect(() => getPublicEnv()).toThrow(ConfigurationError);
  });

  it('rejects an unrecognised app environment', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefgh.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_abc123';
    process.env.NEXT_PUBLIC_APP_ENV = 'prod';

    expect(() => getPublicEnv()).toThrow(ConfigurationError);
  });

  it('memoises, so repeated reads do not re-validate', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefgh.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_abc123';

    expect(getPublicEnv()).toBe(getPublicEnv());
  });
});

describe('inspectPublicEnv', () => {
  it('reports problems without throwing', () => {
    const result = inspectPublicEnv();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.length).toBeGreaterThan(0);
      expect(result.problems.join(' ')).toContain('NEXT_PUBLIC_SUPABASE_URL');
    }
  });

  it('never echoes a configured value, only the variable name', () => {
    // The result is rendered on the dashboard, so it must be safe to display.
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefgh.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_secret_leaky_value_here';

    const result = inspectPublicEnv();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.join(' ')).not.toContain('sb_secret_leaky_value_here');
    }
  });

  it('reports success for a valid configuration', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefgh.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_abc123';

    expect(inspectPublicEnv().ok).toBe(true);
  });
});

describe('getAppEnvironment', () => {
  it('defaults to development and never throws', () => {
    // Used by the logger and the shell, which must work before validation.
    expect(getAppEnvironment()).toBe('development');

    process.env.NEXT_PUBLIC_APP_ENV = 'nonsense';
    expect(getAppEnvironment()).toBe('development');
  });

  it('recognises each supported environment', () => {
    for (const environment of ['development', 'test', 'staging', 'production'] as const) {
      process.env.NEXT_PUBLIC_APP_ENV = environment;
      expect(getAppEnvironment()).toBe(environment);
    }
  });

  it('identifies production', () => {
    process.env.NEXT_PUBLIC_APP_ENV = 'production';
    expect(isProduction()).toBe(true);

    process.env.NEXT_PUBLIC_APP_ENV = 'staging';
    expect(isProduction()).toBe(false);
  });
});

describe('server-only guard', () => {
  it('reports a Node environment as not a browser', () => {
    expect(isBrowser()).toBe(false);
    expect(() => assertServerOnly('Privileged client')).not.toThrow();
  });

  it('refuses when a window object is present', () => {
    // Defence in depth behind the `server-only` import: if a bundler ever
    // pulled a privileged module into client code, this fails loudly rather
    // than handing a secret to the browser.
    const globals = globalThis as { window?: unknown };
    globals.window = {};

    try {
      expect(isBrowser()).toBe(true);
      expect(() => assertServerOnly('Privileged client')).toThrow(ConfigurationError);
      expect(() => assertServerOnly('Privileged client')).toThrow(
        /must never run in a browser/,
      );
    } finally {
      delete globals.window;
    }
  });
});
