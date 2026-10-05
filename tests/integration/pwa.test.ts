import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { GET as manifestRoute } from '@/app/manifest.webmanifest/route';
import { APP_NAME, APP_SHORT_NAME, ROUTES } from '@/config/app';

/**
 * The installable application.
 *
 * Two kinds of assertion here. The manifest is checked by calling the route
 * and reading what it serves, because installability is decided by the actual
 * bytes. The service worker is checked by reading its source, because the
 * property that matters — that it never caches anything behind a session —
 * is a property of what the code *can* do, and a runtime test that happened
 * not to cache a dashboard would prove nothing about the next request.
 */

const SW_PATH = join(process.cwd(), 'public/sw.js');
const sw = readFileSync(SW_PATH, 'utf8');

interface Manifest {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  theme_color: string;
  background_color: string;
  icons: { src: string; sizes: string; type: string; purpose: string }[];
  shortcuts?: { url: string }[];
}

async function manifest(): Promise<Manifest> {
  return (await manifestRoute().json()) as Manifest;
}

describe('the web app manifest', () => {
  it('is served as a manifest, not as JSON', () => {
    // A browser that does not see `application/manifest+json` may refuse to
    // install at all.
    const response = manifestRoute();
    expect(response.headers.get('content-type')).toContain('application/manifest+json');
  });

  it('carries everything a browser requires to offer an install', async () => {
    const value = await manifest();

    expect(value.name).toBe(APP_NAME);
    expect(value.short_name).toBe(APP_SHORT_NAME);
    expect(value.start_url).toBe(ROUTES.dashboard);
    expect(value.display).toBe('standalone');
    expect(value.icons.length).toBeGreaterThanOrEqual(2);
  });

  it('ships a 192 and a 512 icon, both square', async () => {
    const sizes = (await manifest()).icons.map((icon) => icon.sizes);

    // The two sizes Chrome requires before it will offer installation.
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
  });

  it('ships a maskable icon, so Android does not put it on a white plate', async () => {
    const maskable = (await manifest()).icons.filter(
      (icon) => icon.purpose === 'maskable',
    );

    expect(maskable.length).toBeGreaterThanOrEqual(2);
  });

  it('points every icon at a file that exists', async () => {
    for (const icon of (await manifest()).icons) {
      const path = join(process.cwd(), 'public', icon.src);
      const bytes = readFileSync(path);

      expect(bytes.length, icon.src).toBeGreaterThan(0);
      // PNG magic. A manifest entry claiming image/png that is not one makes
      // the install silently fall back to a generated icon.
      expect(bytes.subarray(0, 4).toString('hex'), icon.src).toBe('89504e47');
    }
  });

  it('starts inside its own scope', async () => {
    const value = await manifest();
    expect(value.start_url.startsWith(value.scope)).toBe(true);
  });

  it('uses colours the application actually paints', async () => {
    const value = await manifest();

    // The brand green the header and the primary action use, and the light
    // page background. A theme colour the interface never shows would frame
    // the application in a stranger's colour.
    expect(value.theme_color).toBe('#0f6a41');
    expect(value.background_color).toBe('#f7f8f9');
  });

  it('offers shortcuts that are real routes', async () => {
    const value = await manifest();

    for (const shortcut of value.shortcuts ?? []) {
      expect(shortcut.url.startsWith('/')).toBe(true);
    }
  });
});

describe('the service worker', () => {
  it('caches only build assets and icons', () => {
    // The allow-list is the protection. Everything it admits is immutable
    // build output or an icon; nothing in it can hold a balance.
    const allowList =
      /function isCacheableAsset\(url\) \{([\s\S]*?)\n\}/.exec(sw)?.[1] ?? '';

    expect(allowList).toContain("'/_next/static/'");
    expect(allowList).toContain("'/icons/'");

    // The paths that must never appear in it.
    for (const forbidden of ['/api', '/reports', '/portal', '/payments', '/clients']) {
      expect(allowList, forbidden).not.toContain(forbidden);
    }
  });

  it('caches no navigation response', () => {
    // A cached page is somebody's balance. The navigation handler is
    // network-only with an offline fallback, and must not put the response it
    // got into a cache.
    const handler =
      /async function networkOnlyWithOfflinePage\(request\) \{([\s\S]*?)\n\}/.exec(
        sw,
      )?.[1] ?? '';

    expect(handler).not.toContain('cache.put');
    expect(handler).toContain('fetch(request)');
  });

  it('never handles a request that is not a GET', () => {
    // A POST is a payment, an approval, a reversal. None may be replayed
    // from anywhere but the server.
    expect(sw).toContain("if (request.method !== 'GET') return;");
  });

  it('refuses to cache an opaque or partial response', () => {
    const cacheFirst =
      /async function cacheFirst\(request\) \{([\s\S]*?)\n\}/.exec(sw)?.[1] ?? '';

    expect(cacheFirst).toContain('response.status === 200');
    expect(cacheFirst).toContain("response.type === 'basic'");
  });

  it('empties every cache when the page asks it to', () => {
    // Sent on sign-out: a counter browser changes hands, and the floor under
    // "nothing private is cached" is that there is nothing left at all.
    expect(sw).toContain("'clear-caches'");
    expect(sw).toContain('caches.delete(name)');
  });

  it('waits to be told before taking over', () => {
    // `skipWaiting()` in the install handler would reload every open tab —
    // including a half-filled payment form with a counted stack of notes
    // beside it.
    const install = /addEventListener\('install'[\s\S]*?\n\}\);/.exec(sw)?.[0] ?? '';
    expect(install).not.toContain('skipWaiting');

    // It is reachable, but only through a message the person's click sends.
    expect(sw).toContain("'skip-waiting'");
  });

  it('precaches the offline page and nothing else', () => {
    const install = /addEventListener\('install'[\s\S]*?\n\}\);/.exec(sw)?.[0] ?? '';

    expect(install).toContain('OFFLINE_URL');
    expect(install).not.toContain('addAll');
  });

  it('drops caches from an older version on activation', () => {
    const activate = /addEventListener\('activate'[\s\S]*?\n\}\);/.exec(sw)?.[0] ?? '';

    expect(activate).toContain('caches.delete(name)');
  });
});

describe('the offline page', () => {
  const page = readFileSync(join(process.cwd(), 'app/offline/page.tsx'), 'utf8');

  it('shows no figure at all', () => {
    // The whole point. A balance from an hour ago is indistinguishable from
    // the balance now, and a cashier who takes a payment against one has
    // recorded the wrong thing.
    expect(page).not.toContain('Money');
    expect(page).not.toContain('UGX');
    expect(page).not.toContain('formatUgx');
  });

  it('needs no session, so it can be precached', () => {
    expect(page).toContain("dynamic = 'force-static'");
    expect(page).not.toContain('guardPermission');
    expect(page).not.toContain('createSupabaseServerClient');
  });

  it('says that nothing is queued, because nothing is', () => {
    // Financial mutations are never queued for background sync, and the page
    // says so rather than leaving a person wondering whether their payment
    // will go through later.
    expect(page).toMatch(/only ever recorded when the server confirms/i);
  });

  it('is reachable without signing in', () => {
    const routing = readFileSync(join(process.cwd(), 'lib/auth/routing.ts'), 'utf8');
    expect(routing).toContain('ROUTES.offline');
  });
});
