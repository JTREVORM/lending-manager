/**
 * The response headers this application sends, and the policy behind them.
 *
 * ## Where they are applied, and why not in `next.config.ts`
 *
 * `next.config.ts` can only serve *static* headers. A Content-Security-Policy
 * worth having needs a fresh nonce on every response, so the policy is built
 * here and applied by the proxy, which already runs on every request to keep
 * the session fresh. The static headers moved here too, so there is one list
 * rather than two places to look.
 *
 * ## The shape of the policy
 *
 * Next.js inlines a bootstrap script and streams more, so `script-src` cannot
 * simply be `'self'`. Two mechanisms are available and only one of them is
 * honest:
 *
 *   - `'unsafe-inline'` — permits every inline script, including one an
 *     injection put there. That is not a policy, it is a formality.
 *   - a **nonce** — permits exactly the scripts this server emitted on this
 *     response. An injected `<script>` has no nonce and does not run.
 *
 * So: a nonce, minted per request, and `'strict-dynamic'` so the scripts the
 * bootstrap loads inherit trust without the policy having to enumerate chunk
 * URLs. `'strict-dynamic'` makes host-source expressions in `script-src`
 * ineffective in modern browsers, which is the point: there is no host this
 * application wants to trust for script, only its own nonce.
 *
 * `'unsafe-eval'` is **not** present in production. It is permitted in
 * development because the Next.js dev overlay and React Refresh need it, and
 * that difference is deliberate and asserted in the tests.
 *
 * ## `connect-src`
 *
 * The browser talks to exactly one backend: the Supabase project. Its URL is
 * configuration, so the policy reads it rather than hard-coding a wildcard —
 * `https:` would permit a compromised page to exfiltrate a client list to any
 * host on the internet, which is the main thing a CSP is for in an
 * application like this one.
 */

import { getPublicEnv, isProduction } from '@/lib/env.public';

/** Header name the proxy sets and the layouts read to stamp the nonce. */
export const CSP_NONCE_HEADER = 'x-lending-csp-nonce';

/**
 * A base64 nonce for one response.
 *
 * `crypto.getRandomValues` rather than `Math.random`: a predictable nonce is
 * no nonce at all, and this runs on the Edge runtime where `node:crypto` is
 * not available.
 */
export function createCspNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/** The Supabase origin the browser is allowed to reach, if it is configured. */
function supabaseOrigin(): string | null {
  try {
    return new URL(getPublicEnv().NEXT_PUBLIC_SUPABASE_URL).origin;
  } catch {
    // Not configured yet. The policy still has to be well-formed; omitting
    // the origin fails closed — requests are refused rather than permitted.
    return null;
  }
}

export function buildContentSecurityPolicy(nonce: string): string {
  const production = isProduction();
  const supabase = supabaseOrigin();

  // Supabase Realtime and the auth client use WebSockets, so the wss: form of
  // the same origin is listed alongside it. Both are the one project, not a
  // wildcard.
  const connect = ["'self'"];
  if (supabase !== null) {
    connect.push(supabase, supabase.replace(/^https:/, 'wss:'));
  }

  const directives: readonly (readonly [string, readonly string[]])[] = [
    ['default-src', ["'self'"]],

    [
      'script-src',
      [
        "'self'",
        `'nonce-${nonce}'`,
        // Inherit trust to the chunks the bootstrap loads, rather than
        // enumerating hashed filenames that change every build.
        "'strict-dynamic'",
        // Ignored by browsers that honour strict-dynamic; present so a very
        // old browser still gets *a* policy rather than none.
        'https:',
        // The dev overlay and React Refresh compile in the browser.
        ...(production ? [] : ["'unsafe-eval'"]),
      ],
    ],

    // Tailwind is compiled to a stylesheet, but Next.js still emits inline
    // style attributes for streaming and for the dev overlay, and a nonce
    // cannot be attached to a style *attribute*. `'unsafe-inline'` for styles
    // does not permit script execution; it is the one concession, and it is
    // scoped to style alone.
    ['style-src', ["'self'", "'unsafe-inline'"]],

    // `data:` for the inline SVG icons; `blob:` for a client photograph read
    // from a file input before it is uploaded. Both are same-document.
    ['img-src', ["'self'", 'data:', 'blob:', ...(supabase === null ? [] : [supabase])]],

    ['font-src', ["'self'", 'data:']],
    ['connect-src', connect],

    // Nothing is embedded and nothing is a plugin.
    ['frame-src', ["'none'"]],
    ['object-src', ["'none'"]],
    ['media-src', ["'none'"]],

    // A lending system must not be framed by anyone. Modern equivalent of
    // X-Frame-Options, and the one browsers actually consult.
    ['frame-ancestors', ["'none'"]],

    // A `<base>` injected into the document would silently re-point every
    // relative URL, including the ones a form posts to.
    ['base-uri', ["'self'"]],

    // A form that can post anywhere is an exfiltration channel that survives
    // every other restriction here.
    ['form-action', ["'self'"]],

    // The service worker is ours; nothing else may register one.
    ['worker-src', ["'self'", 'blob:']],
    ['manifest-src', ["'self'"]],
  ];

  const policy = directives
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');

  // Only over HTTPS. In development everything is http://localhost and this
  // directive would break every asset.
  return production ? `${policy}; upgrade-insecure-requests` : policy;
}

/**
 * The headers every response carries, whatever it is.
 *
 * `Strict-Transport-Security` is production-only and deliberately so: sending
 * it from a development server pins `localhost` to HTTPS in the developer's
 * browser for a year, which is a self-inflicted outage with no security
 * benefit. `preload` is omitted — submitting to the preload list is a
 * deployment decision with a slow reversal, and belongs to the launch phase.
 */
export function securityHeaders(nonce: string): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {
    'Content-Security-Policy': buildContentSecurityPolicy(nonce),

    // Kept alongside `frame-ancestors` for browsers that predate CSP Level 2.
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',

    // A loan id or a client number in a path must not travel to another site
    // in a Referer header. Same-origin keeps the full URL internally, where
    // it is useful, and sends only the origin outward.
    'Referrer-Policy': 'strict-origin-when-cross-origin',

    // Everything this application does not use. `interest-cohort` is the
    // legacy FLoC opt-out and costs nothing to keep.
    'Permissions-Policy': [
      'accelerometer=()',
      'autoplay=()',
      'camera=()',
      'display-capture=()',
      'encrypted-media=()',
      'fullscreen=(self)',
      'geolocation=()',
      'gyroscope=()',
      'magnetometer=()',
      'microphone=()',
      'midi=()',
      'payment=()',
      'picture-in-picture=()',
      'publickey-credentials-get=()',
      'screen-wake-lock=()',
      'usb=()',
      'xr-spatial-tracking=()',
      'interest-cohort=()',
    ].join(', '),

    // Cross-origin isolation. `same-origin` on the opener policy severs the
    // window reference a popup would otherwise keep; `same-origin` on the
    // resource policy stops another site embedding our responses.
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',

    'X-DNS-Prefetch-Control': 'off',
  };

  if (isProduction()) {
    headers['Strict-Transport-Security'] = 'max-age=63072000; includeSubDomains';
  }

  return headers;
}

/**
 * Cache directives for a response that depends on who is asking.
 *
 * Every authenticated page in this system shows one person's money. A shared
 * cache that kept any of it would eventually serve one borrower's balance to
 * another, and `private` alone is not enough — a browser's own back/forward
 * cache will happily redisplay a signed-out page.
 *
 * `no-store` is therefore the rule for anything behind a session, and the
 * `Vary` on Cookie makes the intent explicit to any intermediary that ignores
 * it.
 */
export const PRIVATE_CACHE_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  Pragma: 'no-cache',
  Expires: '0',
  Vary: 'Cookie',
};

/**
 * Is this a path whose response may be cached by a shared cache?
 *
 * Only the build's own immutable assets and the handful of static files that
 * carry no session. Everything else — every page, every export, every API
 * route — is private by construction, because this application has no
 * anonymous content beyond the sign-in screen.
 */
export function isPubliclyCacheablePath(pathname: string): boolean {
  return (
    pathname.startsWith('/_next/static/') ||
    pathname === '/manifest.webmanifest' ||
    pathname === '/favicon.ico' ||
    pathname.startsWith('/icons/')
  );
}
