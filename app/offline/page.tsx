import { WifiOff } from 'lucide-react';

export const metadata = { title: 'Offline' };

/**
 * What the service worker shows when the network is gone.
 *
 * Deliberately empty of figures. The temptation on an offline page is to show
 * the last known balance "so the page is useful", and that is exactly the
 * failure this application must not have: a borrower's balance from an hour
 * ago, presented without a date, is indistinguishable from the balance now,
 * and a cashier who reads one and takes a payment against it has recorded the
 * wrong thing.
 *
 * So the page says what it does not know. That is the useful content.
 *
 * It is a static page with no session, which is what lets the worker precache
 * it: a page that needed a session could not be served when there is no
 * network to validate one.
 */
export const dynamic = 'force-static';

export default function OfflinePage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center px-4 py-10 text-center">
      <span className="bg-warning-surface mb-4 flex size-14 items-center justify-center rounded-full">
        <WifiOff aria-hidden="true" className="text-warning size-7" />
      </span>

      <h1 className="text-text">You are offline</h1>

      <p className="text-text-muted mt-3">
        Current loan and payment figures are not available without a connection, and this
        page will not show you an old one — an out-of-date balance looks exactly like a
        current balance.
      </p>

      <p className="text-text-muted mt-3 text-sm">
        Nothing you were part-way through has been lost on the server. Payments, approvals
        and reversals are only ever recorded when the server confirms them, so there is
        nothing waiting to be sent.
      </p>

      <p className="text-text-muted mt-6 text-sm">
        When the connection returns, reload the page.
      </p>
    </main>
  );
}
