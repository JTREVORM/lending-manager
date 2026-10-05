import { expect, expectNoErrorBoundary, stateFile, test } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Registering a client, in a browser, against the real database.
 *
 * Synthetic throughout: the name is invented, the phone number is in the
 * harness's own +25677210xxxx range, and the NIN is a generated pattern. No
 * real person's details appear in this repository.
 */

test.use({ storageState: stateFile('owner') });

/**
 * Search the directory the way a person does.
 *
 * The field commits on Enter or on blur, never on each keystroke — a query per
 * character would be a query per character, and on a phone keyboard it is also
 * unpleasant. So filling the box is not searching, and a test that only filled
 * it would be asserting against an unfiltered list.
 */
async function searchDirectory(page: Page, term: string): Promise<void> {
  const box = page.locator('#client-search');
  await box.fill(term);
  await box.press('Enter');
  await page.waitForURL(new RegExp(`q=${encodeURIComponent(term)}`), { timeout: 15_000 });
}

/**
 * The directory renders every row twice — a card list for phones and a table
 * for wider screens — and hides one of them with `display: none`. So a plain
 * text match finds two nodes, one of which is never visible at this width;
 * asking for the visible one is the only assertion that means "a person can
 * see this".
 */
function visibleInDirectory(page: Page, text: string | RegExp) {
  return page.locator('main').getByText(text).filter({ visible: true });
}

// One registration per run, with a name that cannot collide with the seed's.
//
// The stamp is letters, not digits: the application only accepts letters,
// spaces, hyphens, apostrophes and full stops in a person's name, which is
// correct — and a test whose fixture breaks that rule is testing the
// validator rather than the registration. Digits map to letters so the name
// stays unique per run and stays a name.
const DIGITS_AS_LETTERS = 'abcdefghij';
const STAMP = String(Date.now())
  .slice(-6)
  .split('')
  .map((digit) => DIGITS_AS_LETTERS[Number(digit)] ?? 'x')
  .join('');
const PHONE_SUFFIX = String(Date.now()).slice(-4);
const NEW_CLIENT = {
  fullName: `Kabaale Testimony ${STAMP}`,
  phone: `+25677210${PHONE_SUFFIX}`,
  dateOfBirth: '1990-04-12',
  village: 'Kisaasi',
  district: 'Kampala',
  occupation: 'Grocer',
};

test.describe('registering a client', () => {
  test('the form saves and the directory shows the new record', async ({ page }) => {
    await page.goto('/clients/new');
    await expectNoErrorBoundary(page);

    await page.getByLabel('Full name').fill(NEW_CLIENT.fullName);
    await page.getByLabel('Sex').selectOption('female');
    await page.getByLabel('Date of birth').fill(NEW_CLIENT.dateOfBirth);
    await page.getByLabel(/^Phone number/).fill(NEW_CLIENT.phone);
    await page.getByLabel('Village or area').fill(NEW_CLIENT.village);
    await page.getByLabel('District').fill(NEW_CLIENT.district);
    await page.getByLabel('Occupation').fill(NEW_CLIENT.occupation);

    await page.getByRole('button', { name: /register client/i }).click();

    // The registration lands on the new client's own page.
    await page.waitForURL(/\/clients\/[0-9a-f-]{36}/, { timeout: 20_000 });
    await expect(page.getByText(NEW_CLIENT.fullName).first()).toBeVisible();
    await expectNoErrorBoundary(page);

    // And the directory finds them.
    await page.goto('/clients');
    await searchDirectory(page, STAMP);
    await expect(visibleInDirectory(page, NEW_CLIENT.fullName).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('a duplicate phone number is refused with a message, not a crash', async ({
    page,
  }) => {
    await page.goto('/clients/new');

    await page.getByLabel('Full name').fill(`Nansubuga Second ${STAMP}`);
    await page.getByLabel('Sex').selectOption('male');
    await page.getByLabel('Date of birth').fill('1988-02-02');
    await page.getByLabel(/^Phone number/).fill(NEW_CLIENT.phone);
    await page.getByLabel('Village or area').fill('Bukoto');
    await page.getByLabel('District').fill('Kampala');
    await page.getByLabel('Occupation').fill('Driver');

    await page.getByRole('button', { name: /register client/i }).click();

    await expect(page.getByRole('alert').first()).toBeVisible({ timeout: 20_000 });
    await expectNoErrorBoundary(page);
    await expect(page).toHaveURL(/\/clients\/new/);
  });

  test('a missing required field is reported before anything is written', async ({
    page,
  }) => {
    await page.goto('/clients/new');

    // Full name left empty on purpose.
    await page.getByLabel('Sex').selectOption('female');
    await page.getByLabel('Date of birth').fill('1991-01-01');
    await page.getByLabel(/^Phone number/).fill('+256772109999');
    await page.getByLabel('Village or area').fill('Najjera');
    await page.getByLabel('District').fill('Wakiso');
    await page.getByLabel('Occupation').fill('Tailor');

    await page.getByRole('button', { name: /register client/i }).click();

    await expect(page).toHaveURL(/\/clients\/new/);
    await expectNoErrorBoundary(page);
  });

  test('the submit button cannot be pressed twice into two clients', async ({ page }) => {
    // §43. A slow connection and an impatient second tap must not register
    // the same person twice.
    const stamp = `${STAMP}x`;
    const DOUBLE_TAP_NAME = `Kiwanuka Doubletap ${stamp}`;
    await page.goto('/clients/new');

    await page.getByLabel('Full name').fill(DOUBLE_TAP_NAME);
    await page.getByLabel('Sex').selectOption('male');
    await page.getByLabel('Date of birth').fill('1993-03-03');
    await page.getByLabel(/^Phone number/).fill('+256772108888');
    await page.getByLabel('Village or area').fill('Kyaliwajjala');
    await page.getByLabel('District').fill('Wakiso');
    await page.getByLabel('Occupation').fill('Butcher');

    const submit = page.getByRole('button', { name: /register client/i });

    // Two taps as fast as a finger can manage. Asserting that the button is
    // *seen* disabled would be a race against a render; asserting that two
    // taps produce one client is the guarantee that matters.
    await submit.click();
    await submit.click({ timeout: 2_000 }).catch(() => undefined);

    await page.waitForURL(/\/clients\/[0-9a-f-]{36}/, { timeout: 20_000 });

    await page.goto('/clients');
    await searchDirectory(page, stamp);
    await expect(visibleInDirectory(page, DOUBLE_TAP_NAME).first()).toBeVisible({
      timeout: 15_000,
    });

    // One client, not two. The stamp is unique to this run, so this counts
    // only what these two taps produced — and `post_client`'s own guard is
    // what makes it one rather than the button's disabled state.
    await expect(visibleInDirectory(page, DOUBLE_TAP_NAME)).toHaveCount(1);
  });
});
