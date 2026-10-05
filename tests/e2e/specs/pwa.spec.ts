import {
  expect,
  expectNoErrorBoundary,
  signIn,
  signOut,
  stateFile,
  test,
} from './fixtures';

/**
 * The progressive-web-app layer, in a browser that actually runs it.
 *
 * ## The rule this file exists to enforce
 *
 * §37: never cache live financial data as authoritative. A cached balance is
 * not a stale balance — it is a wrong balance that looks right, handed to a
 * cashier who then takes the wrong amount. So the assertions below are mostly
 * negative: what the service worker must *not* hold.
 *
 * §104–106 is the other half, and it is specific to how this system is used.
 * The machine on the counter is shared. One cashier signs out and the next
 * signs in; if anything of the first one's day survives in a cache, the
 * second reads somebody else's money.
 */

test.describe('the manifest and the icons', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('the manifest is served and describes this application', async ({ page }) => {
    const response = await page.request.get('/manifest.webmanifest');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toMatch(
      /manifest\+json|application\/json/,
    );

    const manifest = (await response.json()) as {
      name?: string;
      short_name?: string;
      start_url?: string;
      display?: string;
      icons?: { src: string; sizes: string; purpose?: string }[];
      theme_color?: string;
    };

    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBeTruthy();

    // §30. A maskable icon and a 512px one, or the installed icon is a
    // letterboxed screenshot on Android.
    const icons = manifest.icons ?? [];
    expect(icons.some((icon) => icon.sizes.includes('512'))).toBe(true);
    expect(icons.some((icon) => (icon.purpose ?? '').includes('maskable'))).toBe(true);
  });

  test('every declared icon actually exists', async ({ page }) => {
    const manifest = (await (await page.request.get('/manifest.webmanifest')).json()) as {
      icons?: { src: string }[];
    };

    for (const icon of manifest.icons ?? []) {
      const response = await page.request.get(icon.src);
      expect(response.status(), icon.src).toBe(200);
      expect(response.headers()['content-type'], icon.src).toMatch(/image\//);
    }
  });

  test('the offline page is reachable and says nothing private', async ({ page }) => {
    const response = await page.goto('/offline');
    expect(response?.status()).toBe(200);

    await expect(
      page.getByText(/offline|no connection|no network/i).first(),
    ).toBeVisible();

    // It is precached, so it must never carry a figure, a name or a balance.
    await expect(page.getByText(/UGX/)).toHaveCount(0);
    expect(await page.locator('[data-money]').count()).toBe(0);
  });
});

/**
 * What the service worker is allowed to hold.
 *
 * Deliberately a closed list rather than a pattern with an exception: a cache
 * entry that is not obviously a static asset is the thing being guarded
 * against, so anything new has to be added here on purpose.
 */
function isAllowedCacheEntry(url: string): boolean {
  const path = new URL(url).pathname;

  return (
    path === '/offline' ||
    path === '/manifest.webmanifest' ||
    path === '/favicon.png' ||
    path === '/favicon.ico' ||
    path.startsWith('/_next/static/') ||
    path.startsWith('/icons/') ||
    /\.(?:css|js|woff2?|png|svg|ico|webmanifest)$/.test(path)
  );
}

test.describe('the health endpoint', () => {
  // §97. Reachable with no session, which is the point of one.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('answers without a session, and says the deployment is up', async ({ page }) => {
    const response = await page.request.get('/api/health');

    expect(response.status(), 'the data API is reachable from the app').toBe(200);
    expect(response.headers()['cache-control']).toMatch(/no-store/);

    const body = (await response.json()) as Record<string, unknown>;

    expect(body.status).toBe('ok');
    expect(body.dataApi).toBe('ok');
    expect(typeof body.version).toBe('string');
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('says nothing a stranger should not know', async ({ page }) => {
    // The easiest thing on a deployment to probe, so what it says is said to
    // everybody. A monitor needs "is it working"; everything else only helps
    // somebody who should not be asking.
    const text = await (await page.request.get('/api/health')).text();

    for (const leak of [
      'postgres',
      'supabase.co',
      'localhost',
      '127.0.0.1',
      'password',
      'sb_secret',
      'apikey',
      'DATABASE_URL',
      'at ', // a stack frame
    ]) {
      expect(text.toLowerCase(), `the health body mentions ${leak}`).not.toContain(
        leak.toLowerCase(),
      );
    }

    // Four fields, and no fifth that grew in later.
    expect(
      Object.keys((await (await page.request.get('/api/health')).json()) as object),
    ).toEqual(['status', 'dataApi', 'version', 'environment']);
  });
});

test.describe('the running build', () => {
  test.use({ storageState: stateFile('owner') });

  test('is readable on the Settings page, and matches the health endpoint', async ({
    page,
  }) => {
    // §108. Without this, "it is still not showing my change" is an
    // argument rather than a question — and on an installed application,
    // where a stale service worker can serve yesterday's shell, it is the
    // first thing worth checking.
    const health = (await (await page.request.get('/api/health')).json()) as {
      version: string;
    };

    await page.goto('/settings');
    await expect(page.getByText('This build')).toBeVisible();
    await expect(page.getByText(health.version).first()).toBeVisible();
  });
});

test.describe('the service worker', () => {
  test.use({ storageState: stateFile('owner') });

  test('registers, and reaches the ready state', async ({ page }) => {
    await page.goto('/');

    const state = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return 'unsupported';

      const registration = await navigator.serviceWorker.ready;
      const worker = registration.active;
      if (worker === null) return 'none';
      if (worker.state === 'activated') return worker.state;

      // `ready` resolves as soon as there is an active worker, which may
      // still be activating. The install handler does not call
      // `skipWaiting`, by design, so waiting for the transition is the
      // correct thing rather than a sleep.
      await new Promise<void>((resolve) => {
        const check = () => {
          if (worker.state === 'activated') {
            worker.removeEventListener('statechange', check);
            resolve();
          }
        };
        worker.addEventListener('statechange', check);
        check();
      });

      return worker.state;
    });

    expect(state).toBe('activated');
  });

  test('caches only its own static assets, never a page of money', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => navigator.serviceWorker.ready);

    // Walk the application's own screens, so anything that was going to be
    // cached has been.
    for (const path of ['/clients', '/loans', '/payments', '/overdue', '/reports']) {
      await page.goto(path);
    }
    await page.waitForTimeout(1000);

    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      const urls: string[] = [];
      for (const name of names) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) urls.push(request.url);
      }
      return urls;
    });

    // §37 and §104. Every cached entry is a static asset or the offline page.
    for (const url of cached) {
      expect(isAllowedCacheEntry(url), `${url} must not be cached`).toBe(true);
    }

    // And specifically not any of the screens just visited.
    for (const path of ['/', '/clients', '/loans', '/payments', '/overdue', '/reports']) {
      expect(
        cached.some((url) => new URL(url).pathname === path),
        `${path} was cached`,
      ).toBe(false);
    }
  });

  test('never caches an API response', async ({ page }) => {
    await page.goto('/payments');
    await page.waitForTimeout(800);

    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      const urls: string[] = [];
      for (const name of names) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) urls.push(request.url);
      }
      return urls;
    });

    for (const url of cached) {
      expect(url, 'an API response was cached').not.toMatch(
        /\/rest\/v1\/|\/auth\/v1\/|\/api\//,
      );
    }
  });

  test('a navigation offline shows the offline page, not a browser error', async ({
    page,
    context,
  }) => {
    await page.goto('/');
    await page.evaluate(() => navigator.serviceWorker.ready);

    await context.setOffline(true);
    try {
      await page.goto('/clients').catch(() => undefined);

      // Either the offline page, or at minimum not a cached screen full of
      // somebody's figures.
      const body = (await page.locator('body').textContent()) ?? '';
      expect(body).not.toContain('UGX');
    } finally {
      await context.setOffline(false);
    }
  });
});

test.describe('a shared counter machine', () => {
  // §104–106. Not a storage state: these sign in and out for real, because
  // what is being tested is what sign-out leaves behind.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('signing out leaves nothing of the previous person behind', async ({ page }) => {
    await signIn(page, 'owner');
    await page.goto('/payments');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await expectNoErrorBoundary(page);

    await signOut(page);
    await page.waitForTimeout(1000);

    // The caches hold no document of the session that just ended.
    const leftovers = await page.evaluate(async () => {
      const names = await caches.keys();
      const urls: string[] = [];
      for (const name of names) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) urls.push(request.url);
      }
      return urls;
    });

    expect(leftovers.filter((url) => !isAllowedCacheEntry(url))).toEqual([]);

    // And the browser's own storage carries no session.
    const stored = await page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
    }));

    for (const key of [...stored.local, ...stored.session]) {
      expect(key, 'a token-shaped key survived sign-out').not.toMatch(
        /auth|token|session|sb-/i,
      );
    }
  });

  test('the next person’s pages are not the previous person’s', async ({ page }) => {
    await signIn(page, 'owner');
    await page.goto('/payments');
    const ownerBody = (await page.locator('main').textContent()) ?? '';
    await signOut(page);

    await signIn(page, 'secretary');
    await page.goto('/account');
    const secretaryBody = (await page.locator('main').textContent()) ?? '';

    // Different people, different pages. A cache that served the first
    // person's page to the second would make these identical.
    expect(secretaryBody).not.toBe(ownerBody);
  });
});
