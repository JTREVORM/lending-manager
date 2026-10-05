import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  expect,
  PASSWORD,
  fixtures,
  resetRateLimits,
  signIn,
  stateFile,
  test,
} from './fixtures';
import type { Who } from './fixtures';

/**
 * Sign each role in once, and save the browser's storage for the specs.
 *
 * ## Why not sign in inside every test
 *
 * Because the application is correct. Sign-in is limited to eight attempts in
 * five minutes per address, and a run of thirty specs that each signed in
 * would spend that budget on its ninth test and then fail the rest — not
 * because anything is broken, but because the limiter is working. A browser
 * does not sign in thirty times either; it signs in once and keeps a session.
 *
 * So this runs first, signs in four times, and writes four storage states.
 * The counters are cleared before it, because the budget is shared with
 * whatever the previous run spent and an E2E run should not be throttled by
 * the one before it.
 */

const ROLES: readonly Who[] = ['owner', 'manager', 'secretary', 'borrower'];

test.describe('sign in once per role', () => {
  test('clear whatever a previous run spent', async () => {
    await resetRateLimits();
  });

  for (const who of ROLES) {
    test(who, async ({ page }) => {
      await signIn(page, who);

      const file = stateFile(who);
      mkdirSync(dirname(file), { recursive: true });
      await page.context().storageState({ path: file });
    });
  }

  test('the credentials are the harness’s own, not a person’s', () => {
    // A guard against a real phone number or a real password ever reaching
    // this directory. Every seeded account is a +25677210xxxx number in the
    // range reserved for the harness, and the password is a literal.
    for (const phone of [...Object.values(fixtures.staff), fixtures.borrower]) {
      expect(phone).toMatch(/^\+2567721\d{5}$/);
    }
    expect(PASSWORD).toContain('Demo');
  });
});
