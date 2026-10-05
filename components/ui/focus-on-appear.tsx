'use client';

import { useEffect, useRef } from 'react';

/**
 * Move focus to something the moment it appears.
 *
 * ## Why this is needed, in one sentence
 *
 * This application confirms every irreversible act in two steps — recording a
 * payment, approving a loan, releasing money, reversing a payment — and in
 * each case the first step **unmounts** when the second appears. The button
 * that was focused stops existing, so the browser drops focus to `<body>`:
 * somebody working by keyboard is returned to the top of the document and has
 * to tab back down past the whole navigation, and somebody using a screen
 * reader is told nothing at all. The screen changed and the only indication
 * was visual.
 *
 * So the panel that appears takes focus, and because it is a heading or a
 * container rather than a control, the reader hears what the step *is* before
 * being offered the button that commits it. That ordering matters here more
 * than it usually does: the thing being announced is how much money is about
 * to change hands.
 *
 * ## Using it
 *
 * The element needs `tabIndex={-1}` — focusable on purpose, never a tab stop
 * of its own:
 *
 * ```tsx
 * const ref = useFocusWhen<HTMLDivElement>(confirming);
 * …
 * {confirming ? <div ref={ref} tabIndex={-1}>…</div> : null}
 * ```
 *
 * Focus is taken only on the transition into `active`, not on every render:
 * stealing focus back from wherever the person has since moved it would be
 * its own bug.
 */
export function useFocusWhen<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T | null>(null);
  const wasActive = useRef(false);

  useEffect(() => {
    if (active && !wasActive.current) ref.current?.focus();
    wasActive.current = active;
  }, [active]);

  return ref;
}
