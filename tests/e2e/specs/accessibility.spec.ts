import AxeBuilder from '@axe-core/playwright';

import { expect, stateFile, test } from './fixtures';

/**
 * WCAG 2.1 AA, measured rather than asserted by eye.
 *
 * ## Why an automated sweep, and what it does not cover
 *
 * axe finds the violations that are decidable from the rendered page: text
 * that does not reach its contrast ratio, a control with no accessible name,
 * a form field with no label, a heading level skipped, a landmark missing, a
 * table cell with no header. Those are most of the ways this application
 * could be unusable to somebody who needs a screen reader or a high-contrast
 * screen, and all of them are regressions that a human reviewer stops
 * noticing after the third pass.
 *
 * It does not judge whether the words are right, whether the reading order
 * makes sense, or whether focus goes somewhere useful after a step changes —
 * those are asserted separately (`navigation.spec.ts` for the skip link and
 * the current-page marker, `payment-ui.test.tsx` for focus on the
 * confirmation panels).
 *
 * ## Every finding is a failure
 *
 * There is no allow-list. A violation that is genuinely not worth fixing
 * would need a written justification here, and so far none has.
 */

const WCAG_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

const SCREENS = [
  '/',
  '/clients',
  '/clients/new',
  '/guarantors',
  '/loans',
  '/loans/new',
  '/payments',
  '/payments/new',
  '/overdue',
  // Phase 14. Debt & Security. Included because these three are the densest
  // screens in the application — a PAR table, a twelve-column guarantor
  // register and five slice tables — and density is where contrast and
  // header association go wrong.
  '/recovery',
  '/recovery?view=risk',
  '/guarantors/register',
  '/payments/summary',
  '/reports',
  '/reports/collections',
  '/reports/arrears',
  '/reports/loans',
  '/reports/clients',
  '/reports/penalties',
  '/reports/grace',
  '/users',
  '/users/new',
  '/audit',
  '/settings',
  '/account',
  '/account/password',
] as const;

test.describe('the staff application meets WCAG AA', () => {
  test.use({ storageState: stateFile('owner') });

  for (const path of SCREENS) {
    test(path, async ({ page }) => {
      await page.goto(path);
      await expect(page.locator('main')).toBeVisible();

      const { violations } = await new AxeBuilder({ page }).withTags(WCAG_AA).analyze();

      // The message names the rule, the impact and one element, which is
      // enough to find it without opening a report.
      const described = violations.map(
        (v) =>
          `${v.id} (${v.impact ?? 'unknown'}): ${v.help} — ${
            v.nodes[0]?.target.join(' ') ?? '?'
          }`,
      );

      expect(described, `${path} has accessibility violations`).toEqual([]);
    });
  }
});

test.describe('the borrower portal meets WCAG AA', () => {
  test.use({ storageState: stateFile('borrower') });

  for (const path of ['/portal', '/account']) {
    test(path, async ({ page }) => {
      await page.goto(path);
      await expect(page.locator('main')).toBeVisible();

      const { violations } = await new AxeBuilder({ page }).withTags(WCAG_AA).analyze();

      expect(
        violations.map((v) => `${v.id}: ${v.help}`),
        `${path} has accessibility violations`,
      ).toEqual([]);
    });
  }
});

test.describe('the sign-in page meets WCAG AA', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const path of ['/login', '/offline']) {
    test(path, async ({ page }) => {
      await page.goto(path);

      const { violations } = await new AxeBuilder({ page }).withTags(WCAG_AA).analyze();

      expect(
        violations.map((v) => `${v.id}: ${v.help}`),
        `${path} has accessibility violations`,
      ).toEqual([]);
    });
  }
});
