import {
  PASSWORD,
  expect,
  expectNoErrorBoundary,
  fixtures,
  resetRateLimits,
  signIn,
  signOut,
  stateFile,
  test,
} from './fixtures';

/**
 * Who may get in, and what they may reach once they are in.
 *
 * The important half of this file is the second describe block: it asks for
 * each privileged page **by its URL**, as somebody who has signed in and
 * typed the address. A hidden menu entry is a courtesy; the refusal is the
 * protection, and the only way to tell the difference is to go around the
 * menu.
 */

test.describe('signing in', () => {
  // These tests spend sign-in attempts deliberately, so they start from a
  // clean budget and do not inherit one from the setup project.
  test.beforeEach(async () => {
    await resetRateLimits();
  });

  test('the wrong password does not get in, and does not say which half was wrong', async ({
    page,
  }) => {
    await page.goto('/login');
    await page.getByLabel('Phone number').fill(fixtures.staff.owner);
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: /sign in/i }).click();

    // Scoped past Next's route announcer, which is also `role="alert"` and
    // always present but empty, so an unscoped match is two elements.
    const alert = page.getByRole('alert').filter({ hasText: /\S/ }).first();

    await expect(alert).toContainText(/login details|phone number or password/i);
    await expect(page).toHaveURL(/\/login/);

    // Naming which of the two was wrong would confirm that an account exists
    // for a phone number somebody is guessing.
    await expect(alert).not.toContainText(/no account|unknown user|no such/i);
  });

  test('an unknown phone number is refused identically', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Phone number').fill('+256772999999');
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: /sign in/i }).click();

    await expect(page.getByRole('alert').filter({ hasText: /\S/ }).first()).toContainText(
      /login details|phone number or password/i,
    );
  });

  test('repeated wrong guesses are eventually refused by the limiter', async ({
    page,
  }) => {
    // §50. Eight attempts in five minutes. The ninth must not be a ninth
    // guess, and the message must not publish the limit.
    await page.goto('/login');

    let limited = false;

    for (let attempt = 1; attempt <= 12 && !limited; attempt += 1) {
      await page.getByLabel('Phone number').fill(fixtures.staff.owner);
      await page.getByLabel('Password').fill(`wrong-${String(attempt)}`);
      await page.getByRole('button', { name: /sign in/i }).click();

      const alert = page.getByRole('alert').filter({ hasText: /\S/ }).first();
      await expect(alert).toBeVisible();
      limited = /too many/i.test((await alert.textContent()) ?? '');
    }

    expect(limited, 'the sign-in limiter refused an attempt').toBe(true);
    await expect(
      page.getByRole('alert').filter({ hasText: /\S/ }).first(),
    ).not.toContainText(/\b8\b|\b5 minutes\b/);
  });

  test('a signed-in person is sent on from the login page', async ({ page }) => {
    await signIn(page, 'secretary');
    await page.goto('/login');
    await expect(page).not.toHaveURL(/\/login/);
  });

  test('signing out ends the session for the back button too', async ({ page }) => {
    await signIn(page, 'secretary');
    await page.goto('/payments');
    await signOut(page);

    // The browser's own history must not show a page of somebody's money
    // after they have signed out of a shared counter machine.
    await page.goto('/payments');
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe('a temporary password must be changed before anything else', () => {
  test.beforeEach(async () => {
    await resetRateLimits();
  });

  test('every route redirects to the password form', async ({ page }) => {
    // §63. The account carries `must_change_password`, set the way
    // `reset_user_password` sets it.
    await page.goto('/login');
    await page.getByLabel('Phone number').fill(fixtures.staff.temporaryPassword);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: /sign in/i }).click();

    await page.waitForURL(/\/account\/password/, { timeout: 20_000 });
    await expect(page.getByRole('heading', { name: /change password/i })).toBeVisible();

    // And it cannot be walked around by typing another address.
    for (const path of ['/', '/clients', '/payments/new', '/reports']) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/account\/password/);
    }
  });
});

/**
 * Role isolation, asked for by URL rather than by clicking.
 *
 * ## The table below is the capability matrix, not a guess
 *
 * The first draft of this file assumed a manager could reach neither `/users`
 * nor `/settings`, and failed — because a manager holds `users:view` and
 * `settings:view`. The application was right and the test was wrong, which is
 * the more dangerous way round: a test that asserts a stricter policy than the
 * product has will be "fixed" by loosening the product.
 *
 * So each row below is taken from `role_permissions`, and the two kinds of
 * refusal are asserted separately:
 *
 *   - **No capability for the route at all** — the route guard turns the
 *     request away. A redirect, a 403 or a 404; never the page.
 *   - **Read but not write** — the page renders, and the controls that would
 *     change something are not on it. Hiding a control is not the protection
 *     (the Server Action checks again, and Row Level Security after that), but
 *     offering a button that leads to a refusal is its own defect.
 */

const NO_ACCESS: readonly {
  readonly who: 'manager' | 'secretary';
  readonly path: string;
}[] = [
  // A manager has no `audit:view` and no `users:create`.
  { who: 'manager', path: '/audit' },
  { who: 'manager', path: '/users/new' },
  // A secretary/treasurer has none of the three.
  { who: 'secretary', path: '/users' },
  { who: 'secretary', path: '/users/new' },
  { who: 'secretary', path: '/audit' },
];

for (const { who, path } of NO_ACCESS) {
  test.describe(`${who} typing ${path}`, () => {
    test.use({ storageState: stateFile(who) });

    test('is turned away', async ({ page }) => {
      const response = await page.goto(path);
      const status = response?.status() ?? 0;
      const landed = new URL(page.url()).pathname;

      await expectNoErrorBoundary(page);

      if (landed === path && status === 200) {
        // Same page, 200: the only acceptable reading is an explicit refusal.
        await expect(
          page.getByText(/not allowed|do not have permission|no access|refused/i).first(),
          `${who} should not be able to read ${path}`,
        ).toBeVisible();
      } else {
        // Redirected away, or refused outright.
        expect(
          landed !== path || status === 403 || status === 404,
          `${who} reached ${path} with ${String(status)}`,
        ).toBe(true);
      }
    });
  });
}

/**
 * Read-only access, and the controls that must not come with it.
 *
 * Each entry names a page the role may read and the write controls it must not
 * be offered there.
 */
const READ_ONLY: readonly {
  readonly who: 'manager' | 'secretary';
  readonly path: string;
  readonly mustNotOffer: readonly RegExp[];
}[] = [
  {
    // `users:view` without `users:create`, `users:update`, `users:disable`,
    // `users:reset_password` or `users:assign_role`.
    who: 'manager',
    path: '/users',
    mustNotOffer: [/add staff/i, /reset.*password/i, /disable/i, /change.*role/i],
  },
  {
    // `settings:view` without `settings:update`.
    who: 'manager',
    path: '/settings',
    mustNotOffer: [/save/i, /update/i, /change/i],
  },
  {
    who: 'secretary',
    path: '/settings',
    mustNotOffer: [/save/i, /update/i, /change/i],
  },
];

for (const { who, path, mustNotOffer } of READ_ONLY) {
  test.describe(`${who} reading ${path}`, () => {
    test.use({ storageState: stateFile(who) });

    test('may read it, and is offered nothing that writes', async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expectNoErrorBoundary(page);

      // It really is the page, not a refusal.
      await expect(page.locator('main')).toBeVisible();

      for (const control of mustNotOffer) {
        await expect(
          page.locator('main').getByRole('button', { name: control }),
          `${who} is offered ${String(control)} on ${path}`,
        ).toHaveCount(0);
        await expect(
          page.locator('main').getByRole('link', { name: control }),
          `${who} is offered ${String(control)} on ${path}`,
        ).toHaveCount(0);
      }
    });
  });
}

test.describe('a borrower is confined to the portal', () => {
  test.use({ storageState: stateFile('borrower') });

  for (const path of [
    '/',
    '/clients',
    '/loans',
    '/payments',
    '/overdue',
    '/reports',
    '/users',
  ]) {
    test(`cannot read ${path}`, async ({ page }) => {
      await page.goto(path);
      // The borrower's own landing place is the portal; the staff shell is
      // not theirs to read whatever they type.
      const landed = new URL(page.url()).pathname;
      expect(
        landed.startsWith('/portal') ||
          landed.startsWith('/login') ||
          landed.startsWith('/account'),
        `${path} landed on ${landed}`,
      ).toBe(true);
    });
  }
});

test.describe('anonymous visitors', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const path of [
    '/',
    '/clients',
    '/loans',
    '/payments',
    '/reports',
    '/users',
    '/portal',
  ]) {
    test(`${path} requires a session`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login/);
    });
  }

  test('the login page itself is reachable and has no stale private data', async ({
    page,
  }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // §104–106. Nothing from a previous user may survive on a shared machine.
    await expect(page.getByText(/UGX/)).toHaveCount(0);
  });
});
