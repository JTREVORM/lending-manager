import { expect, fixtures, resetRateLimits, signIn, stateFile, test } from './fixtures';

/**
 * The headers, the Content-Security-Policy and the limits, as a browser sees
 * them.
 *
 * The unit tests assert what `buildContentSecurityPolicy` returns. That is not
 * the same claim as "the policy the browser enforces lets the application run
 * and nothing else" — a nonce that the framework does not pick up produces a
 * policy that looks perfect and a page with no JavaScript. Only a browser can
 * report that, and it reports it as a console violation.
 */

test.describe('the response headers', () => {
  test.use({ storageState: stateFile('owner') });

  test('every page carries the policy, with a fresh nonce each time', async ({
    page,
  }) => {
    const nonces = new Set<string>();

    for (const path of ['/', '/clients', '/payments', '/reports']) {
      const response = await page.goto(path);
      const csp = response?.headers()['content-security-policy'];

      expect(csp, `${path} has no policy`).toBeTruthy();
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain('strict-dynamic');
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("base-uri 'self'");

      // §44. No `unsafe-eval` in a production build.
      expect(csp, `${path} allows eval`).not.toContain("'unsafe-eval'");

      const nonce = /'nonce-([A-Za-z0-9+/=_-]+)'/.exec(csp ?? '')?.[1];
      expect(nonce, `${path} has no nonce`).toBeTruthy();
      nonces.add(nonce!);
    }

    // A nonce reused across responses is not a nonce.
    expect(nonces.size).toBe(4);
  });

  test('the other headers are present', async ({ page }) => {
    const response = await page.goto('/');
    const headers = response?.headers() ?? {};

    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toMatch(/no-referrer|strict-origin/);
    expect(headers['x-frame-options'] ?? 'DENY').toMatch(/DENY|SAMEORIGIN/);
    expect(headers['permissions-policy']).toBeTruthy();
    // Clickjacking is covered twice over: the header and `frame-ancestors`.
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  test('a page of money is never stored by a shared cache', async ({ page }) => {
    for (const path of ['/', '/clients', '/payments', '/reports/collections']) {
      const response = await page.goto(path);
      const cacheControl = response?.headers()['cache-control'] ?? '';
      expect(cacheControl, `${path} may be cached`).toMatch(/no-store/);
    }
  });

  test('the application runs under its own policy, with no violation', async ({
    page,
  }) => {
    // The assertion the unit tests cannot make. A CSP violation is reported
    // to the console, and a page whose scripts were all blocked still
    // renders its server HTML — so it looks fine and does nothing.
    const violations: string[] = [];
    page.on('console', (message) => {
      const text = message.text();
      if (/Content Security Policy|Refused to (load|execute|apply)/i.test(text)) {
        violations.push(text);
      }
    });

    for (const path of [
      '/',
      '/clients',
      '/loans',
      '/payments/new',
      '/overdue',
      '/recovery',
      '/reports',
    ]) {
      await page.goto(path);
    }

    expect(violations).toEqual([]);

    // And proof that scripts did run: the service worker only registers
    // from JavaScript the policy allowed.
    const registered = await page.evaluate(
      async () => (await navigator.serviceWorker.getRegistrations()).length,
    );
    expect(registered).toBeGreaterThan(0);
  });

  test('the policy this server sends is one a browser enforces', async ({ page }) => {
    // Enforcement, not wording — but it has to be measured carefully.
    //
    // A probe written as `page.evaluate` proves nothing: Chrome exempts
    // evaluation arriving over the devtools protocol from CSP, so both an
    // injected `<script>` and a bare `eval` succeed however strict the policy
    // is. Both were tried, and both passed against a policy that forbade
    // them.
    //
    // What can be measured is the policy itself, applied by the browser to a
    // document. The real header is read from a real response, a document
    // carrying that exact header is served on this origin, and the question
    // is whether its un-nonced inline script ran. If the browser enforces the
    // string this server sends, it did not.
    const live = await page.request.get('/');
    const policy = live.headers()['content-security-policy'] ?? '';
    expect(policy).toBeTruthy();

    await page.route('**/csp-enforcement-probe', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        headers: { 'content-security-policy': policy },
        body: `<!doctype html><html><body><div id="r">blocked</div>
               <script>document.getElementById('r').textContent = 'ran';</script>
               </body></html>`,
      });
    });

    await page.goto('/csp-enforcement-probe');
    await expect(page.locator('#r')).toHaveText('blocked');

    await page.unroute('**/csp-enforcement-probe');
  });
});

test.describe('the login page', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('carries the policy before anybody has signed in', async ({ page }) => {
    const response = await page.goto('/login');
    const csp = response?.headers()['content-security-policy'] ?? '';

    expect(csp).toContain("default-src 'self'");
    expect(csp).toMatch(/'nonce-/);
    expect(response?.headers()['cache-control']).toMatch(/no-store/);
  });

  test('the session cookie is not readable from JavaScript', async ({ page }) => {
    // `@supabase/ssr` writes the session without `HttpOnly`, because its
    // browser client reads it out of `document.cookie`. This application has
    // no browser client — every read and write is a Server Component or a
    // Server Action — so that is a privilege nothing uses and an injected
    // script on a shared counter machine would. `hardenSessionCookie` removes
    // it; this is where the removal is observable, and where its presence was
    // found.
    await signIn(page, 'manager');
    await page.goto('/');

    const visible = await page.evaluate(() => document.cookie);
    expect(visible, 'a session cookie is exposed to scripts').not.toMatch(
      /sb-|auth-token/,
    );

    // And the session still works — the half that would break if anything in
    // the browser did need to read it.
    await expect(page.locator('main')).toBeVisible();
    expect(new URL(page.url()).pathname).not.toBe('/login');
  });
});

test.describe('the rate limits', () => {
  test.use({ storageState: stateFile('owner') });

  test.beforeEach(async () => {
    await resetRateLimits();
  });

  test('an export is refused once the budget is spent, with Retry-After', async ({
    page,
  }) => {
    // §50. Ten in ten minutes. Not one global number: a cashier recording
    // payments must not be throttled by somebody downloading a report.
    await page.goto('/reports/collections');
    const link = page.getByRole('link', { name: /download csv/i }).first();
    const href = (await link.getAttribute('href')) ?? '/reports/collections/export';

    let limited: { status: number; retryAfter: string | undefined } | undefined;

    for (let attempt = 1; attempt <= 15 && limited === undefined; attempt += 1) {
      const response = await page.request.get(href);
      if (response.status() === 429) {
        limited = {
          status: response.status(),
          retryAfter: response.headers()['retry-after'],
        };
      }
    }

    expect(limited, 'the export limiter never refused').toBeDefined();
    expect(limited!.retryAfter, 'a refusal must say when to come back').toBeTruthy();
    expect(Number(limited!.retryAfter)).toBeGreaterThan(0);
  });

  test('a refusal does not publish the policy', async ({ page }) => {
    await page.goto('/reports/collections');
    const href = '/reports/collections/export';

    for (let attempt = 1; attempt <= 15; attempt += 1) {
      const response = await page.request.get(href);
      if (response.status() !== 429) continue;

      const body = await response.text();
      // "Wait a few minutes" tells a person what to do. The limit and the
      // window would tell a script how fast it may go.
      expect(body).not.toMatch(/\b10 (requests|per)\b/);
      expect(response.headers()['x-ratelimit-limit']).toBeUndefined();
      expect(response.headers()['x-ratelimit-remaining']).toBeUndefined();
      return;
    }

    throw new Error('the export limiter never refused');
  });
});

test.describe('the privileged key', () => {
  test.use({ storageState: stateFile('owner') });

  test('never reaches the browser', async ({ page }) => {
    // §121. The one thing that must never leak. Asserted against everything
    // the browser actually downloaded, not against the source tree.
    const bodies: string[] = [];

    page.on('response', async (response) => {
      const type = response.headers()['content-type'] ?? '';
      if (!/javascript|html|json/.test(type)) return;
      try {
        bodies.push(await response.text());
      } catch {
        // A redirect or a body already consumed; nothing to inspect.
      }
    });

    for (const path of ['/', '/clients', '/payments/new', '/reports', '/settings']) {
      await page.goto(path);
    }
    await page.waitForTimeout(500);

    expect(bodies.length).toBeGreaterThan(3);

    for (const body of bodies) {
      expect(body, 'a secret key reached the browser').not.toContain('sb_secret');
      expect(body).not.toContain('service_role');
      expect(body).not.toContain('SUPABASE_SECRET_KEY');
    }
  });

  test('the client’s own identifiers are the publishable ones', async ({ page }) => {
    await page.goto('/');

    const exposed = await page.evaluate(() =>
      JSON.stringify(
        Object.keys(window).filter((key) => /supabase|secret|service/i.test(key)),
      ),
    );

    expect(exposed).toBe('[]');
  });
});

test.describe('a direct request to the data API', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('the rate-limit counters are unreachable', async ({ page }) => {
    // The table is RLS-on with no policies and every grant revoked, so it is
    // not readable even by a signed-in staff member. A dump of it would say
    // which phone numbers somebody has been trying.
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
    test.skip(url === '', 'no Supabase URL in the environment');

    const response = await page.request.get(
      `${url}/rest/v1/rate_limit_counters?select=*`,
      {
        headers: {
          apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '',
        },
        failOnStatusCode: false,
      },
    );

    expect([401, 403, 404]).toContain(response.status());
  });

  test('a borrower’s phone number is not readable anonymously', async ({ page }) => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
    test.skip(url === '', 'no Supabase URL in the environment');

    const response = await page.request.get(
      `${url}/rest/v1/clients?select=full_name,phone`,
      {
        headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '' },
        failOnStatusCode: false,
      },
    );

    if (response.status() === 200) {
      expect(await response.json()).toEqual([]);
    } else {
      expect([401, 403, 404]).toContain(response.status());
    }

    expect(fixtures.borrower).toMatch(/^\+2567/);
  });
});
