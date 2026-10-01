'use client';

import { CircleAlert } from 'lucide-react';
import { useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

/**
 * Route-level error boundary.
 *
 * ## What the user sees
 *
 * A plain-language apology and a retry button. Deliberately NOT: the error
 * message, the stack, the SQL, or the `digest`. Next.js already strips server
 * error messages in production, but this component must not reintroduce them
 * — `error.message` from a database failure can carry table names, column
 * names and row values.
 *
 * The `digest` is a hash Next.js writes to the server log alongside the real
 * error. It is shown only outside production, where it helps a developer
 * correlate the two.
 */
export default function Error({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  useEffect(() => {
    // The server has already logged the real error. This records that the
    // boundary was reached, keyed by digest so the two can be joined.
    // `console.error` rather than lib/logger.ts: that module is written for
    // the server and would pull its redaction rules into the client bundle.
    if (process.env.NODE_ENV !== 'production') {
      // Development-only diagnostic. The server log already holds the real
      // error; lib/logger.ts is server-side and must not be pulled into the
      // client bundle, so `console` is the only option here.
      // eslint-disable-next-line no-console
      console.error('Route error boundary reached', error.digest ?? '(no digest)');
    }
  }, [error]);

  return (
    <div className="mx-auto flex min-h-dvh max-w-md items-center justify-center px-4 py-10">
      <Card className="w-full">
        <div className="flex gap-3">
          <span className="bg-danger-surface flex size-10 shrink-0 items-center justify-center rounded-lg">
            <CircleAlert aria-hidden="true" className="text-danger size-5" />
          </span>
          <div className="min-w-0">
            <h1 className="text-lg">Something went wrong</h1>
            <p className="text-text-muted mt-2 text-sm">
              The page could not be loaded. Nothing has been saved. Please try again, and
              tell your administrator if it keeps happening.
            </p>

            {process.env.NODE_ENV !== 'production' && error.digest !== undefined ? (
              <p className="text-text-muted mt-3 font-mono text-xs">
                Reference: {error.digest}
              </p>
            ) : null}

            <Button onClick={reset} className="mt-5">
              Try again
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
