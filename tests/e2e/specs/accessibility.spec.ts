import AxeBuilder from '@axe-core/playwright';

import { expect, queryHarness, stateFile, test } from './fixtures';

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
  // Polytos Phase 1. Both membership screens. The register because it is a
  // seven-column table, which is the shape that fails a contrast or a scroll
  // check first; the policy screen because its amber "Not decided" marker is
  // the one piece of new colour in the system, and 12px text on a tinted
  // surface is exactly where a contrast ratio quietly lands under 4.5:1.
  '/membership',
  '/membership/policies',
  // Polytos Phase 3. The two member-lending registers are the widest tables
  // added since the guarantor register — nine columns and seven — and the
  // application form is the only screen in the application that renders a
  // live-recomputed money table while somebody types into it. Both shapes
  // fail a contrast or a header-association check before a simpler one does.
  '/member-loans',
  '/member-loans?tab=loans',
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
  '/notifications',
  '/recovery',
  '/recovery?view=risk',
  '/guarantors/register',
  '/payments/summary',
  '/reports',
  // The group chips and the one-group listing are their own rendering.
  '/reports?group=behind',
  '/reports/collections',
  '/reports/arrears',
  '/reports/loans',
  '/reports/clients',
  '/reports/penalties',
  '/reports/grace',
  // Phase 16 — the four Debt & Security reports. Each is a wide table, which
  // is exactly the shape that fails a contrast or a scroll check first.
  '/reports/aging',
  '/reports/recovery',
  '/reports/guarantors',
  '/reports/collateral',
  '/users',
  '/users/new',
  '/audit',
  '/settings',
  '/settings?section=finance',
  '/finance?section=cash',
  '/finance/trial-balance',
  '/payments/summary?section=branch',
  '/account',
  '/account/password',
  // Polytos Phase 4D. Five of the fourteen agency screens, chosen the same
  // way: the densest tables and the screens that put a control inside one.
  // `/agency/history` is a nine-column register; the two reconciliation
  // screens render a checkbox, a revealed reason field and a submit button
  // inside a table cell, which is where a label association or a focus order
  // goes wrong first; `/agency/providers` carries a struck-through money
  // column, whose contrast on a tinted surface is exactly the thing to
  // check; `/agency/record` is the form a counter officer uses all day.
  '/agency/record',
  '/agency/history',
  '/agency/reconciliation/cash',
  '/agency/reconciliation/float',
  '/agency/providers',
  // Phase 4E. The five Mobile Money screens are a dashboard, a provider
  // screen with a form and a register, two more form screens and the line
  // administration; two of them cover every pattern the others use, and
  // adding them found a real contrast failure — `text-muted` is a surface
  // colour, and using it as text is a WCAG AA violation wherever it lands.
  '/agency/money',
  '/agency/lines',
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

/**
 * The agency transaction detail screen, which the list above cannot name.
 *
 * ## Why it was not swept, and why that mattered
 *
 * `SCREENS` is a list of paths, and this screen's path contains a
 * transaction id. So the densest screen the agency module has — the figures
 * table, the commission-exception authorisation, the reference correction and
 * the lifecycle controls, four panels of small print and tinted surfaces —
 * was the one screen none of this suite had ever looked at.
 *
 * Three components live only here or mostly here:
 * `commission-exception-form.tsx`, `lifecycle-controls.tsx` and the
 * reference-correction form. Phase 4E reported them as carrying a contrast
 * fault; on inspection they do not — every one uses `text-text-muted`, the
 * approved token, and `tests/unit/colour-contrast.test.ts` holds that token
 * to AA on every ground it lands on, in both the light and the dark palette.
 * But "we looked and it seemed fine" is what this suite exists to replace,
 * and the fact that the claim could be made at all is the argument for
 * sweeping the screen rather than reasoning about it.
 *
 * ## Why these two statuses
 *
 * The panels are conditional on status, so one URL does not render them all:
 *
 *   * **awaiting verification** renders every panel at once — the exception
 *     form (draft or awaiting), the reference correction (posted or
 *     awaiting) and the lifecycle controls (always). It is the fullest the
 *     screen ever gets;
 *   * **posted** renders the lifecycle controls in their reversal state,
 *     which is different markup — a reason field and a destructive button —
 *     and the only state in which it appears.
 *
 * The ids come from the seeded book rather than being written here: the
 * harness posts and submits real transactions, and a hard-coded id would be
 * a fixture that rots.
 */
test.describe('the agency transaction detail screen meets WCAG AA', () => {
  test.use({ storageState: stateFile('owner') });

  for (const status of ['awaiting_verification', 'posted'] as const) {
    test(`/agency/history/[id] — ${status}`, async ({ page }) => {
      const rows = await queryHarness<{ id: string }>(
        `select id::text as id from public.agency_transactions
          where status = $1 order by created_at limit 1`,
        [status],
      );
      const id = rows[0]?.id;
      expect(
        id,
        `the harness seeds no ${status} agency transaction to sweep`,
      ).toBeDefined();

      await page.goto(`/agency/history/${id ?? ''}`);
      await expect(page.locator('main')).toBeVisible();

      const { violations } = await new AxeBuilder({ page }).withTags(WCAG_AA).analyze();

      const described = violations.map(
        (v) =>
          `${v.id} (${v.impact ?? 'unknown'}): ${v.help} — ${
            v.nodes[0]?.target.join(' ') ?? '?'
          }`,
      );

      expect(
        described,
        `/agency/history/[id] (${status}) has accessibility violations`,
      ).toEqual([]);
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
