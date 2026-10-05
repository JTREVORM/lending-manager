'use client';

import { Download } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Card } from '@/components/ui/card';

/**
 * Offers to install the application, where the browser supports it.
 *
 * ## Why this lives in My account rather than popping up
 *
 * A prompt that appears over the screen is a prompt that appears while
 * somebody is counting money. The browser already fires
 * `beforeinstallprompt` on its own schedule; this component catches it,
 * suppresses the browser's banner, and puts a quiet card where a person goes
 * when they are *looking* for settings.
 *
 * It renders nothing at all unless the browser has offered. On iOS, which
 * does not implement the event, nothing appears and the Safari share menu is
 * the install path — telling an iPhone user to "tap install" when there is no
 * install button is worse than saying nothing.
 *
 * ## It never asks twice
 *
 * Once the person has chosen — installed or dismissed — the card goes and the
 * choice is remembered. A business application that nags is one people learn
 * to dismiss without reading.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DECLINED_KEY = 'lending:install-declined';

export function InstallCard() {
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  // Read lazily rather than in an effect. There is no hydration risk: the
  // component renders nothing until the browser fires `beforeinstallprompt`,
  // which it never does during server rendering, so the first client render
  // and the server's agree whatever this returns.
  const [declined, setDeclined] = useState(() => {
    try {
      return window.localStorage.getItem(DECLINED_KEY) === 'yes';
    } catch {
      // Server rendering, or a private window. Neither is a decision to
      // decline.
      return false;
    }
  });

  useEffect(() => {
    const onPrompt = (event: Event): void => {
      // Suppress the browser's own banner so the offer appears here instead,
      // where it is not in anybody's way.
      event.preventDefault();
      setPrompt(event as BeforeInstallPromptEvent);
    };

    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
    };
  }, []);

  const remember = useCallback(() => {
    try {
      window.localStorage.setItem(DECLINED_KEY, 'yes');
    } catch {
      // A private window cannot remember. The card reappearing next session
      // is a smaller problem than sign-out failing.
    }
    setDeclined(true);
    setPrompt(null);
  }, []);

  const install = useCallback(async () => {
    if (prompt === null) return;

    await prompt.prompt();
    await prompt.userChoice;

    // Either way the offer is spent: the browser will not replay this event.
    remember();
  }, [prompt, remember]);

  if (prompt === null || declined) return null;

  return (
    <Card>
      <div className="flex items-start gap-3">
        <span className="bg-accent-surface flex size-10 shrink-0 items-center justify-center rounded-lg">
          <Download aria-hidden="true" className="text-accent size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-text text-base font-semibold">Install on this device</h2>
          <p className="text-text-muted mt-1 text-sm">
            Adds an icon to the home screen and opens without the browser bar. It is the
            same system and the same sign-in — nothing is stored on the device.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                void install();
              }}
              className="bg-accent text-accent-contrast min-h-touch rounded-lg px-4 text-sm font-medium"
            >
              Install
            </button>
            <button
              type="button"
              onClick={remember}
              className="border-border-strong text-text min-h-touch rounded-lg border px-4 text-sm font-medium"
            >
              Not now
            </button>
          </div>
        </div>
      </div>
    </Card>
  );
}
