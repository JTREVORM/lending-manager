import { readFileSync } from 'node:fs';

import type { NextConfig } from 'next';

/**
 * The build's own version, read from `package.json` at build time.
 *
 * Phase 9 §108 asks for a version somewhere a person can read it, so that
 * "it is not showing my change" can be answered rather than argued about. It
 * is also what the health endpoint reports.
 *
 * Read here rather than imported: importing `package.json` into application
 * code would pull the whole manifest — including the dependency list — into
 * the bundle. This inlines one string.
 */
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

/**
 * Build configuration.
 *
 * ## Where the security headers went
 *
 * They used to be declared here. A `headers()` entry in this file is static
 * by construction, and a Content-Security-Policy worth having needs a nonce
 * minted per response — so as of Phase 9 the whole set is built in
 * `lib/security/headers.ts` and applied by the proxy, which already runs on
 * every request. One list, one place, and it can vary by environment and by
 * path.
 *
 * Nothing is declared here instead of there, deliberately: two sources of
 * headers is how a policy ends up weaker on one route than its author thinks.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Type errors must fail the build. Never flip this to `true`.
  //
  // There is no `eslint` key: Next.js 16 removed `next lint` and the build no
  // longer runs ESLint. Linting is a separate gate — `npm run lint`, which
  // `npm run verify` and CI both run.
  typescript: { ignoreBuildErrors: false },

  // Do not leak the framework version in response headers.
  poweredByHeader: false,

  // Source maps are not emitted for the production browser bundle. They would
  // publish the application's own source — including the shape of every
  // server action and permission check — to anyone who opens devtools. Server
  // -side stack traces are unaffected; they never reach a browser.
  productionBrowserSourceMaps: false,

  // The one build-time constant the application is given. Public on purpose:
  // it is a version number, and both the Settings page and the health
  // endpoint report it.
  env: { NEXT_PUBLIC_APP_VERSION: version },
};

export default nextConfig;
