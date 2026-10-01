/**
 * Runtime guard against privileged code executing in a browser.
 *
 * Next.js's `server-only` package is the primary protection: it makes the
 * build fail if a server module is imported into a Client Component. This is a
 * defence in depth for the cases a build-time check cannot see — a module
 * pulled in dynamically, or a bundler misconfiguration — and it fails loudly
 * rather than silently handing a secret to the client.
 */

import { ConfigurationError } from '@/lib/errors';

/** Is this code executing in a browser? */
export function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

/**
 * Abort if called in a browser.
 *
 * @param what Name of the operation, used in the error message.
 * @throws ConfigurationError when a `window` object is present.
 */
export function assertServerOnly(what: string): void {
  if (isBrowser()) {
    throw new ConfigurationError(
      `${what} must never run in a browser. This indicates a server-only module was bundled into client code.`,
    );
  }
}
