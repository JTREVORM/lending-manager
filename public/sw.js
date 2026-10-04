/* global self, caches, fetch, Request, Response, URL */

/**
 * The service worker.
 *
 * ## What it is for, and what it is emphatically not for
 *
 * This is a lending system. Everything a signed-in person sees is one
 * borrower's money, and almost all of it changes the moment somebody pays.
 * So this worker exists to do exactly two things:
 *
 *   1. serve the build's own static assets from cache, so the application
 *      opens quickly on a slow connection; and
 *   2. show an honest offline page when the network is gone.
 *
 * It does **not** cache a single page, API response, report, receipt or
 * balance. Not with a short TTL, not stale-while-revalidate, not "just the
 * dashboard". A borrower's balance served from a cache is a figure that was
 * true at some point and is being presented as true now, and there is no way
 * for the person reading it to tell which. That is worse than showing
 * nothing, which is why the offline page says what it does not know rather
 * than showing the last thing it saw.
 *
 * ## The isolation problem
 *
 * A browser at a lending counter is shared. Cashier A signs in, works, signs
 * out; cashier B signs in. A worker that cached authenticated responses would
 * hand B whatever A was looking at — the same failure as a shared HTTP cache,
 * except it survives the sign-out that was supposed to end A's session.
 *
 * The defence is structural rather than careful: nothing with a session is
 * ever put in a cache, so there is nothing to leak. `ALLOWED` below is a
 * closed list of paths, every one of them a build asset or an icon, and the
 * fetch handler consults it before it considers caching anything. Belt and
 * braces: the application posts `clear-caches` on sign-out and this worker
 * deletes every cache it owns, so even a future mistake has a floor.
 */

const VERSION = 'v1';
const ASSET_CACHE = `lending-assets-${VERSION}`;
const SHELL_CACHE = `lending-shell-${VERSION}`;

/** The offline page. Precached, because it is needed exactly when the network is not. */
const OFFLINE_URL = '/offline';

/**
 * The only things this worker will ever read from or write to a cache.
 *
 * A predicate over the URL, not a list of what happened to be requested. A
 * response is cacheable only if its path matches here *and* the request was a
 * same-origin GET that returned 200 — three conditions, because a single one
 * is a single mistake away from caching a dashboard.
 */
function isCacheableAsset(url) {
  if (url.origin !== self.location.origin) return false;

  return (
    // Hashed build output. Immutable by construction: a change produces a new
    // filename, so there is no staleness to reason about.
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/favicon.png' ||
    url.pathname === '/favicon.ico' ||
    url.pathname === '/manifest.webmanifest'
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await cache.add(new Request(OFFLINE_URL, { cache: 'reload' }));
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop every cache from an older version of this worker. A stale asset
      // cache is how a new deployment ends up running last week's JavaScript
      // against this week's server.
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name !== ASSET_CACHE && name !== SHELL_CACHE)
          .map((name) => caches.delete(name)),
      );

      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Only GET. A POST is a payment, an approval, a reversal — things that must
  // reach the server and be answered by it, never replayed from anywhere.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (isCacheableAsset(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // A page. Always the network, and the offline page when there is none.
  // Deliberately no fallback to a cached copy of the page itself: there is no
  // cached copy, and if there were it would be somebody's balance.
  if (request.mode === 'navigate') {
    event.respondWith(networkOnlyWithOfflinePage(request));
    return;
  }

  // Everything else — data, exports, images from storage — goes straight to
  // the network with no involvement from this worker at all.
});

async function cacheFirst(request) {
  const cache = await caches.open(ASSET_CACHE);
  const hit = await cache.match(request);
  if (hit !== undefined) return hit;

  const response = await fetch(request);

  // 200 and basic only. An opaque or redirected response tells us nothing
  // about what it contains, and a 206 would cache a fragment as if it were
  // the whole file.
  if (response.status === 200 && response.type === 'basic') {
    cache.put(request, response.clone()).catch(() => undefined);
  }

  return response;
}

async function networkOnlyWithOfflinePage(request) {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    const offline = await cache.match(OFFLINE_URL);

    if (offline !== undefined) return offline;

    return new Response('You are offline.', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
}

/**
 * Messages from the page.
 *
 * `clear-caches` is sent on sign-out. Nothing private should be in a cache to
 * begin with; this is the floor under that claim, and it costs one line at
 * the one moment it matters.
 *
 * `skip-waiting` is sent when the person accepts an update, never
 * automatically — see `components/pwa/service-worker-provider.tsx` for why a
 * worker must not take over while a payment form is half filled in.
 */
self.addEventListener('message', (event) => {
  const data = event.data;

  if (data === 'skip-waiting' || data?.type === 'skip-waiting') {
    void self.skipWaiting();
    return;
  }

  if (data === 'clear-caches' || data?.type === 'clear-caches') {
    event.waitUntil(
      (async () => {
        const names = await caches.keys();
        await Promise.all(names.map((name) => caches.delete(name)));
      })(),
    );
  }
});
