import type { NextConfig } from 'next';

/**
 * Security headers applied to every response.
 *
 * Deliberately conservative: this is a financial application, so framing,
 * MIME sniffing and cross-origin referrer leakage are all denied by default.
 *
 * A Content-Security-Policy is intentionally NOT set here yet — Phase 2
 * introduces Supabase Auth flows and will need a nonce-based CSP wired through
 * the proxy to avoid breaking them. See docs/SECURITY.md.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=()',
  },
] as const;

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

  // Not `async`: the config type expects a Promise-returning function, and
  // there is nothing to await.
  headers() {
    return Promise.resolve([{ source: '/:path*', headers: [...securityHeaders] }]);
  },
};

export default nextConfig;
