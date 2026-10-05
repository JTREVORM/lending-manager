import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PRIVATE_CACHE_HEADERS,
  buildContentSecurityPolicy,
  createCspNonce,
  isPubliclyCacheablePath,
  securityHeaders,
} from '@/lib/security/headers';
import { resetPublicEnvCache } from '@/lib/env.public';

/**
 * The response policy.
 *
 * These assertions are about the strings the application actually sends.
 * `tests/integration/security-headers.test.ts` proves the proxy attaches
 * them; this file proves they say the right thing, which is the part a diff
 * can quietly change.
 */

const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://demo.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
  resetPublicEnvCache();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  resetPublicEnvCache();
});

const directive = (policy: string, name: string): string =>
  policy
    .split('; ')
    .find((part) => part.startsWith(`${name} `))
    ?.slice(name.length + 1) ?? '';

describe('the nonce', () => {
  it('differs on every request', () => {
    const seen = new Set(Array.from({ length: 50 }, () => createCspNonce()));

    // A nonce that repeats is a nonce an attacker can reuse from a cached
    // page, which is the same as having none.
    expect(seen.size).toBe(50);
  });

  it('is long enough to be unguessable', () => {
    // 16 random bytes, base64. Anything shorter is brute-forceable within the
    // lifetime of a page.
    expect(createCspNonce()).toMatch(/^[A-Za-z0-9+/]{21,24}={0,2}$/);
  });
});

describe('the content security policy', () => {
  it('admits inline script only by nonce', () => {
    const policy = buildContentSecurityPolicy('abc123');
    const scriptSrc = directive(policy, 'script-src');

    expect(scriptSrc).toContain("'nonce-abc123'");
    // The alternative to a nonce is permitting *every* inline script,
    // including one an injection put there. That is not a policy.
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it('permits eval only when the development server is serving', () => {
    // The dev overlay and React Refresh compile in the browser, and they
    // exist only under `next dev`.
    vi.stubEnv('NODE_ENV', 'development');
    resetPublicEnvCache();
    expect(directive(buildContentSecurityPolicy('n'), 'script-src')).toContain(
      "'unsafe-eval'",
    );

    vi.stubEnv('NODE_ENV', 'production');
    resetPublicEnvCache();
    expect(directive(buildContentSecurityPolicy('n'), 'script-src')).not.toContain(
      "'unsafe-eval'",
    );

    vi.unstubAllEnvs();
    resetPublicEnvCache();
  });

  it('does not permit eval in a built artefact merely because it is not labelled production', () => {
    // The defect this asserts against: the gate used to be
    // `NEXT_PUBLIC_APP_ENV === 'production'`, which is a deployment label.
    // A staging or test deployment is a `next build` artefact with no dev
    // overlay in it, and it was being handed `'unsafe-eval'` anyway. The
    // end-to-end harness, which runs the production build under the label
    // `test`, read the header out of a real response and found it.
    vi.stubEnv('NODE_ENV', 'production');

    for (const label of ['test', 'staging', 'development']) {
      process.env.NEXT_PUBLIC_APP_ENV = label;
      resetPublicEnvCache();
      expect(
        directive(buildContentSecurityPolicy('n'), 'script-src'),
        label,
      ).not.toContain("'unsafe-eval'");
    }

    vi.unstubAllEnvs();
    resetPublicEnvCache();
  });

  it('lets the browser reach the Supabase project and nothing else', () => {
    const connect = directive(buildContentSecurityPolicy('n'), 'connect-src');

    expect(connect).toContain("'self'");
    expect(connect).toContain('https://demo.supabase.co');
    expect(connect).toContain('wss://demo.supabase.co');

    // A compromised page with `connect-src https:` can post the client list
    // anywhere. This is the directive that stops exfiltration.
    expect(connect).not.toContain('https:;');
    expect(connect.split(' ')).not.toContain('*');
  });

  it('fails closed when Supabase is not configured', () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    resetPublicEnvCache();

    const connect = directive(buildContentSecurityPolicy('n'), 'connect-src');

    // Refusing the request is the safe direction for a misconfiguration to
    // fail; widening the policy to a wildcard is not.
    expect(connect).toBe("'self'");
  });

  it('refuses to be framed by anybody', () => {
    expect(directive(buildContentSecurityPolicy('n'), 'frame-ancestors')).toBe("'none'");
  });

  it('pins the base URI and the form target', () => {
    const policy = buildContentSecurityPolicy('n');

    // A `<base>` injected into the document re-points every relative URL,
    // including the one a payment form posts to.
    expect(directive(policy, 'base-uri')).toBe("'self'");
    expect(directive(policy, 'form-action')).toBe("'self'");
  });

  it('allows no plugins and no embedded documents', () => {
    const policy = buildContentSecurityPolicy('n');

    expect(directive(policy, 'object-src')).toBe("'none'");
    expect(directive(policy, 'frame-src')).toBe("'none'");
  });

  it('upgrades insecure requests in production only', () => {
    process.env.NEXT_PUBLIC_APP_ENV = 'production';
    resetPublicEnvCache();
    expect(buildContentSecurityPolicy('n')).toContain('upgrade-insecure-requests');

    // Everything is http://localhost in development; the directive would
    // break every asset.
    process.env.NEXT_PUBLIC_APP_ENV = 'development';
    resetPublicEnvCache();
    expect(buildContentSecurityPolicy('n')).not.toContain('upgrade-insecure-requests');
  });
});

describe('the rest of the headers', () => {
  it('sends HSTS in production and never in development', () => {
    process.env.NEXT_PUBLIC_APP_ENV = 'production';
    resetPublicEnvCache();
    expect(securityHeaders('n')['Strict-Transport-Security']).toContain('max-age=');

    // Sending it from a dev server pins localhost to HTTPS in the
    // developer's browser for a year.
    process.env.NEXT_PUBLIC_APP_ENV = 'development';
    resetPublicEnvCache();
    expect(securityHeaders('n')['Strict-Transport-Security']).toBeUndefined();
  });

  it('does not submit to the HSTS preload list', () => {
    process.env.NEXT_PUBLIC_APP_ENV = 'production';
    resetPublicEnvCache();

    // Preloading is slow to reverse and is a launch decision, not a code one.
    expect(securityHeaders('n')['Strict-Transport-Security']).not.toContain('preload');
  });

  it('denies the device capabilities the application does not use', () => {
    const policy = securityHeaders('n')['Permissions-Policy'] ?? '';

    for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb']) {
      expect(policy, feature).toContain(`${feature}=()`);
    }
  });

  it('keeps X-Frame-Options alongside frame-ancestors', () => {
    // CSP Level 2 is what browsers consult; the header is for anything older.
    expect(securityHeaders('n')['X-Frame-Options']).toBe('DENY');
  });

  it('refuses MIME sniffing and cross-origin embedding', () => {
    const headers = securityHeaders('n');

    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin');
    expect(headers['Cross-Origin-Resource-Policy']).toBe('same-origin');
  });

  it('sends only the origin to another site', () => {
    // A loan id in a path must not travel in a Referer header.
    expect(securityHeaders('n')['Referrer-Policy']).toBe(
      'strict-origin-when-cross-origin',
    );
  });
});

describe('cache policy', () => {
  it('stores nothing that depends on who is asking', () => {
    expect(PRIVATE_CACHE_HEADERS['Cache-Control']).toContain('no-store');
    expect(PRIVATE_CACHE_HEADERS['Cache-Control']).toContain('private');
    // Explicit for any intermediary that reads Vary but not Cache-Control.
    expect(PRIVATE_CACHE_HEADERS.Vary).toBe('Cookie');
  });

  it('treats build assets as cacheable and every page as private', () => {
    expect(isPubliclyCacheablePath('/_next/static/chunks/main.js')).toBe(true);
    expect(isPubliclyCacheablePath('/manifest.webmanifest')).toBe(true);
    expect(isPubliclyCacheablePath('/icons/icon-192.png')).toBe(true);

    // Everything a person can read is one person's money.
    for (const path of [
      '/',
      '/clients',
      '/loans/abc',
      '/payments/abc',
      '/reports/collections',
      '/reports/collections/export',
      '/portal',
      '/login',
    ]) {
      expect(isPubliclyCacheablePath(path), path).toBe(false);
    }
  });
});
