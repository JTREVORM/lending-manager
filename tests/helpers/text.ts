import { screen, type Matcher } from '@testing-library/react';

/**
 * Find an element by the text it *reads as*, across its child elements.
 *
 * ## Why this exists
 *
 * Testing Library's `getByText` matches a single element whose own text
 * content matches. A sentence like
 *
 *   `UGX 50,000 penalty pending`
 *
 * used to be one text node, because the amount was interpolated as a string.
 * Phase 9 renders every sum through `<Money>`, so the amount is now its own
 * `<span>` — which is the entire point: a span can be told not to break, and
 * a string in the middle of a sentence cannot.
 *
 * The rendered words did not change. What changed is that they are now spread
 * over three nodes, and `getByText` stops matching. Reaching for
 * `{ exact: false }` or asserting on a fragment would both quietly weaken the
 * assertion, so this matcher does the opposite: it matches an element whose
 * **own** composed text matches, and only the innermost such element, so a
 * match still proves the pieces are adjacent inside one element rather than
 * merely present somewhere on the page.
 *
 * Use it wherever a sentence contains a rendered value. Plain `getByText` is
 * still right for text that is genuinely one node.
 */
export function compositeText(
  expected: Matcher,
): (content: string, element: Element | null) => boolean {
  const matches = (text: string): boolean => {
    if (typeof expected === 'string') return text === expected;
    if (expected instanceof RegExp) return expected.test(text);
    if (typeof expected === 'function') return expected(text, null);
    return false;
  };

  return (_content, element) => {
    if (element === null) return false;

    const text = normalise(element.textContent ?? '');
    if (!matches(text)) return false;

    // Only the innermost element that matches. Without this a match on a
    // `<span>` also matches its `<div>`, its `<section>` and `<body>`, and
    // `getByText` throws for finding several.
    return !Array.from(element.children).some((child) =>
      matches(normalise(child.textContent ?? '')),
    );
  };
}

/** Collapse the whitespace a JSX line break introduces. */
function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** `screen.getByText` with the composite matcher applied. */
export function getByCompositeText(expected: Matcher): HTMLElement {
  return screen.getByText(compositeText(expected));
}

/** `screen.queryByText` with the composite matcher applied. */
export function queryByCompositeText(expected: Matcher): HTMLElement | null {
  return screen.queryByText(compositeText(expected));
}
