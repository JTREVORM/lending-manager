'use client';

import { RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Registers the service worker, and offers an update when one is waiting.
 *
 * ## Why the update is offered rather than applied
 *
 * The usual pattern is `skipWaiting()` in the worker's install handler, which
 * takes over immediately and reloads every open tab. In this application a
 * tab might be a half-filled payment form with a counted stack of notes
 * beside it, and reloading it loses the amount, the method and the reference
 * the cashier has already typed. So the new worker waits, a quiet bar says
 * there is an update, and the person chooses the moment.
 *
 * The bar is deliberately small and dismissible. A banner that cannot be
 * dismissed is a banner people learn to work around.
 *
 * ## Why registration is client-side and conditional
 *
 * A service worker needs a secure context. On `http://localhost` the browser
 * treats it as secure; on any other plain-HTTP origin it refuses, and
 * attempting it logs an error that looks like a fault. Registration is also
 * skipped when the browser does not support it, which is a statement about
 * progressive enhancement rather than a guess: everything works without it.
 */
export function ServiceWorkerProvider() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    let cancelled = false;

    const register = async (): Promise<void> => {
      try {
        const registration = await navigator.serviceWorker.register('/sw.js', {
          scope: '/',
        });
        if (cancelled) return;

        registrationRef.current = registration;

        // Already waiting when the page loaded — a previous visit downloaded
        // it and the person never reloaded.
        if (registration.waiting !== null) setWaiting(registration.waiting);

        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          if (installing === null) return;

          installing.addEventListener('statechange', () => {
            // `controller !== null` distinguishes an update from the very
            // first install. On a first install there is nothing to offer:
            // the worker takes over on the next navigation and nothing is
            // stale.
            if (
              installing.state === 'installed' &&
              navigator.serviceWorker.controller !== null
            ) {
              setWaiting(installing);
            }
          });
        });
      } catch {
        // A refused registration is not a fault the person can act on, and
        // the application works without it.
      }
    };

    void register();

    return () => {
      cancelled = true;
    };
  }, []);

  const applyUpdate = useCallback(() => {
    if (waiting === null) return;

    // One reload, once the new worker has taken over. Listening for
    // `controllerchange` rather than reloading immediately avoids the race
    // where the page reloads into the old worker and the banner reappears.
    navigator.serviceWorker.addEventListener(
      'controllerchange',
      () => {
        window.location.reload();
      },
      { once: true },
    );

    waiting.postMessage({ type: 'skip-waiting' });
  }, [waiting]);

  if (waiting === null || dismissed) return null;

  return (
    <div
      role="status"
      className="sw-update-notice border-border bg-surface fixed inset-x-0 bottom-0 z-30 mx-auto flex w-[min(28rem,calc(100%-2rem))] items-center gap-3 rounded-lg border p-3 shadow-lg print:hidden"
    >
      <RefreshCw aria-hidden="true" className="text-accent size-5 shrink-0" />
      <p className="text-text min-w-0 flex-1 text-sm">
        A new version is ready. Finish what you are doing, then reload.
      </p>
      <button
        type="button"
        onClick={applyUpdate}
        className="bg-accent text-accent-contrast min-h-touch shrink-0 rounded-lg px-3 text-sm font-medium"
      >
        Reload
      </button>
      <button
        type="button"
        onClick={() => {
          setDismissed(true);
        }}
        className="text-text-muted hover:text-text min-h-touch shrink-0 px-1"
      >
        <X aria-hidden="true" className="size-4" />
        <span className="sr-only">Dismiss</span>
      </button>
    </div>
  );
}

/**
 * Empty every cache this origin holds.
 *
 * Called on sign-out. Nothing private is cached in the first place — the
 * worker's allow-list is a closed set of build assets — so this is the floor
 * under that claim rather than the claim itself. It costs one message at the
 * one moment a shared counter browser changes hands.
 */
export async function clearServiceWorkerCaches(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;

  try {
    navigator.serviceWorker.controller?.postMessage({ type: 'clear-caches' });

    // Also directly, because a page with no controller yet (a first visit
    // that signs straight out) would otherwise skip the message entirely.
    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names.map((name) => caches.delete(name)));
    }
  } catch {
    // Storage can be unavailable in a private window. Signing out must not
    // fail because a cache could not be emptied.
  }
}
