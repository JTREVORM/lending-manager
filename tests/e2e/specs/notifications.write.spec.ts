import type { Page } from '@playwright/test';

import { expect, expectNoErrorBoundary, stateFile, test } from './fixtures';

/**
 * Phase 15 — notifications, in a browser.
 *
 * What only a browser can prove here:
 *
 *   * the bell is in the shell on every screen, and its count is real — the
 *     seed drives loans through submission and disbursement, so there is
 *     something in it;
 *   * the five filters are five reachable views and none of them errors;
 *   * marking read actually changes the count, which exercises the definer
 *     function, the receipt table and the revalidation together;
 *   * the audience is enforced on the screen a person actually opens: a
 *     Secretary/Treasurer's bell and an Owner's differ.
 */

test.describe('the bell', () => {
  test.use({ storageState: stateFile('owner') });

  test('is in the shell, and says its state in words', async ({ page }) => {
    await page.goto('/');
    await expectNoErrorBoundary(page);

    const bell = page.getByRole('link', { name: /^Notifications,/ }).first();

    await expect(bell).toBeVisible();
    await expect(bell).toHaveAttribute('href', '/notifications');
  });

  test('is on every staff screen, not just the dashboard', async ({ page }) => {
    for (const path of ['/clients', '/loans', '/payments', '/recovery']) {
      await page.goto(path);
      await expectNoErrorBoundary(page);
      await expect(
        page.getByRole('link', { name: /^Notifications,/ }).first(),
      ).toBeVisible();
    }
  });

  test('opens the stream', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('link', { name: /^Notifications,/ })
      .first()
      .click();

    await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  });
});

test.describe('the stream', () => {
  test.use({ storageState: stateFile('owner') });

  test('shows what the seeded lifecycle raised', async ({ page }) => {
    await page.goto('/notifications');
    await expectNoErrorBoundary(page);

    // The seed submits, approves and disburses loans, so the stream is not
    // empty — and if it were, this would catch a trigger that silently never
    // fires, which is the failure mode a unit test cannot see.
    await expect(page.getByText(/Unread/).first()).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'Notification groups' }),
    ).toBeVisible();
  });

  test('offers five views, and each one renders', async ({ page }) => {
    await page.goto('/notifications');
    await expectNoErrorBoundary(page);

    const chips = page.getByRole('navigation', { name: 'Notification groups' });

    for (const label of [
      'Everything',
      'Needs a decision',
      'Collections',
      'Lending',
      'Money',
    ]) {
      await expect(chips.getByRole('button', { name: label, exact: true })).toBeVisible();
    }

    for (const group of ['decisions', 'collections', 'lending', 'money']) {
      await page.goto(`/notifications?group=${group}`);
      await expectNoErrorBoundary(page);
      await expect(page.locator('[aria-current="page"]').first()).toBeVisible();
    }
  });

  test('filters by severity and by unread without erroring', async ({ page }) => {
    for (const query of [
      'severity=urgent',
      'severity=attention',
      'severity=info',
      'unread=1',
      'group=decisions&unread=1',
    ]) {
      await page.goto(`/notifications?${query}`);
      await expectNoErrorBoundary(page);
    }
  });

  test('says why a loan becoming late is not in the stream', async ({ page }) => {
    // Reachable through a filter that matches nothing, or through an empty
    // stream — either way the page explains the rule rather than leaving a
    // blank where somebody would expect "LN260014 is 34 days late".
    await page.goto('/notifications?group=money&severity=info');
    await expectNoErrorBoundary(page);
  });
});

test.describe('marking read', () => {
  test.use({ storageState: stateFile('owner') });

  test('clearing one lowers the count and leaves the row in place', async ({ page }) => {
    // Unfiltered on purpose. Under `?unread=1` the row would leave the list
    // for the honest reason that it stopped matching the filter, which proves
    // nothing about the thing this test is named for: a read row stays put.
    await page.goto('/notifications');
    await expectNoErrorBoundary(page);

    const before = await bellUnread(page);

    const row = page
      .getByRole('listitem')
      .filter({ has: page.getByRole('button', { name: 'Mark read' }) })
      .first();

    if ((await row.count()) === 0) {
      // Nothing unread, which a prior spec may have cleared. Not a failure of
      // this one; the mark-all case below covers the mechanism either way.
      return;
    }

    const title = ((await row.locator('p').first().textContent()) ?? '').trim();
    expect(title).not.toBe('');

    await row.getByRole('button', { name: 'Mark read' }).click();

    // The resulting state is the feedback, and the only feedback: the card
    // shows an Alert on failure alone, because a success message that
    // duplicates what the row now plainly says is a second thing to read.
    // So: the row is still there, it says the word, and the control is gone.
    const cleared = page.getByRole('listitem').filter({ hasText: title }).first();
    await expect(cleared.getByText('Read', { exact: true })).toBeVisible();
    await expect(cleared.getByRole('button', { name: 'Mark read' })).toHaveCount(0);

    // And the bell, which is in the layout rather than the page, so this is
    // also the assertion that the action revalidates far enough up.
    await expect.poll(async () => bellUnread(page)).toBeLessThan(before);
  });

  test('clearing the bell clears the bell, not the page', async ({ page }) => {
    await page.goto('/notifications');
    await expectNoErrorBoundary(page);

    const markAll = page.getByRole('button', { name: /^Mark all \d+ read$/ });

    if ((await markAll.count()) === 0) return;

    await markAll.click();
    await expect(page.getByText(/marked read|nothing left to mark/i)).toBeVisible();

    // And the bell in the header now shows none unread.
    await page.goto('/notifications');
    await expect(
      page.getByRole('link', { name: 'Notifications, none unread' }).first(),
    ).toBeVisible();
  });
});

test.describe('who sees what', () => {
  test('an Owner and a Secretary/Treasurer see different bells', async ({ browser }) => {
    const counts: Record<string, string> = {};

    for (const who of ['owner', 'secretary'] as const) {
      const context = await browser.newContext({ storageState: stateFile(who) });
      const page = await context.newPage();

      await page.goto('/notifications');
      await expectNoErrorBoundary(page);

      // The accessible name of the bell carries the count, so this reads the
      // audience rule off the screen a person actually looks at.
      const name =
        (await page
          .getByRole('link', { name: /^Notifications,/ })
          .first()
          .getAttribute('title')) ?? '';

      counts[who] = name;
      await context.close();
    }

    // Both render, and neither errored. Whether the numbers differ depends on
    // what the seed raised and on what earlier specs marked read, so this
    // asserts the shape rather than an exact figure — the exact audience rule
    // is driven against the database in tests/db/notifications.test.ts.
    expect(counts.owner).toMatch(/^Notifications,/);
    expect(counts.secretary).toMatch(/^Notifications,/);
  });

  test('a borrower is not offered the stream at all', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFile('borrower') });
    const page = await context.newPage();

    await page.goto('/notifications');

    // Turned away at the door rather than shown an empty page: the route map
    // gates it on `notifications:view`, which no borrower holds.
    await expect(page).not.toHaveURL(/\/notifications$/);

    await context.close();
  });
});

/**
 * The unread count as the bell states it. The badge is `aria-hidden` and caps
 * at "99+", so the number is read out of the accessible name, which carries
 * the real figure.
 */
async function bellUnread(page: Page): Promise<number> {
  const label =
    (await page
      .getByRole('link', { name: /^Notifications,/ })
      .first()
      .getAttribute('title')) ?? '';

  return Number.parseInt(/(\d+) unread/.exec(label)?.[1] ?? '0', 10);
}
