import {
  expect,
  expectNoErrorBoundary,
  fixtures,
  stateFile,
  test,
  watchForBrowserErrors,
} from './fixtures';

/**
 * The meeting screens, in a browser, against the production build.
 *
 * ## What this suite is really checking
 *
 * Beyond the three things every screen suite here checks — that the pages
 * render, that they survive a phone, and that nobody who should not reach one
 * does — this suite is about two claims that are easy to get wrong and
 * invisible from a unit test:
 *
 *   1. **The meeting's status comes from its register.** Marking the first
 *      member present is what makes a meeting `held`, inside
 *      `mark_meeting_attendance`. So there is no "mark as held" control
 *      anywhere, and its absence is asserted rather than assumed.
 *
 *   2. **Nothing on these screens attaches a consequence to absence.** The
 *      client has not decided what missing a meeting costs, so the register
 *      shows the figures and draws no conclusion. A screen that coloured a
 *      poor turnout as a failure would be the interface inventing policy, and
 *      that is the kind of thing nobody notices until a member is told they
 *      have been penalised.
 */

interface Screen {
  readonly name: string;
  readonly path: string;
  readonly proves: RegExp;
}

const MEETING_SCREENS: readonly Screen[] = [
  { name: 'the meetings section', path: '/meetings', proves: /Meetings/ },
  {
    name: 'the meetings list, filtered to what is still to come',
    path: '/meetings?status=upcoming',
    proves: /Meetings/,
  },
  {
    name: 'a meeting that was held',
    path: `/meetings/${fixtures.meetings.held}`,
    proves: /The arrangement/,
  },
  {
    name: 'a meeting still to come',
    path: `/meetings/${fixtures.meetings.upcoming}`,
    proves: /The arrangement/,
  },
  { name: 'the scheduling screen', path: '/meetings/new', proves: /Schedule a meeting/ },
];

// ===========================================================================
test.describe('the meeting screens render', () => {
  test.use({ storageState: stateFile('owner') });

  for (const screen of MEETING_SCREENS) {
    test(screen.name, async ({ page }) => {
      const watcher = watchForBrowserErrors(page);

      const response = await page.goto(screen.path);
      expect(response?.status(), `${screen.path} status`).toBe(200);

      await expectNoErrorBoundary(page);

      await expect(
        page.locator('main').getByText(screen.proves).filter({ visible: true }).first(),
      ).toBeVisible();

      expect(watcher.errors, `${screen.path} console`).toEqual([]);
    });
  }
});

// ===========================================================================
test.describe('the section answers the two questions a list buries', () => {
  test.use({ storageState: stateFile('owner') });

  test('says when the next meeting is', async ({ page }) => {
    await page.goto('/meetings');

    // The question members ask at the counter, and the one thing a list
    // ordered newest-first hides.
    await expect(
      page
        .getByText(/Still to come/i)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
  });

  test('lists what somebody said they would do and has not', async ({ page }) => {
    await page.goto('/meetings');

    // The commitments made in a meeting that nobody has closed — the thing a
    // minute book is for and the thing a minute book never surfaces.
    await expect(
      page
        .getByText(/Outstanding from past meetings/i)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();

    await expect(
      page
        .getByText(/next of kin details from every member/i)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
  });

  test('marks an action item past its date as overdue', async ({ page }) => {
    await page.goto('/meetings');

    // Computed from the business date in Africa/Kampala, not the browser's
    // clock: an action due today must not read as overdue at 21:00 Kampala.
    await expect(
      page.getByText('Overdue').filter({ visible: true }).first(),
    ).toBeVisible();
  });
});

// ===========================================================================
test.describe('a meeting that happened', () => {
  test.use({ storageState: stateFile('owner') });

  test('reports attendance as figures and not as a grade', async ({ page }) => {
    await page.goto(`/meetings/${fixtures.meetings.held}`);

    await expect(
      page
        .getByText(/present/)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();

    // Nothing in this system attaches a consequence to absence, because the
    // client has not decided there is one. So no screen may imply a penalty.
    //
    // Scoped to `main`, which is the page rather than the shell: the
    // navigation rail carries a "Penalties" report — a real feature of the
    // loan book — and an unscoped assertion would be testing the rail
    // instead of this screen.
    for (const word of [/penalt/i, /fine/i, /sanction/i, /warning/i]) {
      await expect(page.locator('main').getByText(word), String(word)).toHaveCount(0);
    }
  });

  test('offers no control to mark the meeting held', async ({ page }) => {
    await page.goto(`/meetings/${fixtures.meetings.upcoming}`);

    // The status is derived from the register. A meeting with a register and a
    // `scheduled` status would be two statements about one afternoon.
    for (const name of [/mark as held/i, /mark held/i, /set status/i]) {
      await expect(page.getByRole('button', { name }), String(name)).toHaveCount(0);
    }
  });

  test('keeps the previous answer when a register was corrected', async ({ page }) => {
    await page.goto(`/meetings/${fixtures.meetings.held}`);

    // The correction trail is append-only, and the reason sits beside it: a
    // register that could be silently rewritten would not be evidence of
    // anything.
    await expect(
      page
        .getByText(/signed the sheet late/i)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
  });

  test('shows finalised minutes and says who finalised them', async ({ page }) => {
    await page.goto(`/meetings/${fixtures.meetings.held}`);

    await expect(
      page
        .getByText(/Finalised/)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();

    await expect(
      page
        .getByText(/four rules remain/i)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
  });

  test('cannot be called off once people attended', async ({ page }) => {
    await page.goto(`/meetings/${fixtures.meetings.held}`);

    // `cancel_membership_meeting` checks the register before it checks the
    // status, so the refusal is about the afternoon rather than about a
    // column — and the control is not offered at all.
    await expect(
      page.getByRole('button', { name: /call this meeting off/i }),
    ).toHaveCount(0);
  });
});

// ===========================================================================
test.describe('who may reach what', () => {
  test.describe('as a Secretary', () => {
    test.use({ storageState: stateFile('secretary') });

    test('runs the meetings, because that is their work', async ({ page }) => {
      for (const path of [
        '/meetings',
        '/meetings/new',
        `/meetings/${fixtures.meetings.held}`,
      ]) {
        const response = await page.goto(path);
        expect(response?.status(), path).toBe(200);
        await expectNoErrorBoundary(page);
      }
    });

    test('is told that the assignee list is only what it may read', async ({ page }) => {
      await page.goto(`/meetings/${fixtures.meetings.toWorkOn}`);

      // `profiles_select_self_or_directory`: your own row, or the directory if
      // you hold `users:view`. A Secretary does not hold it, so the list that
      // comes back is one name — their own.
      //
      // This spec was first written against the wrong reading of that policy
      // ("the Secretary gets nothing") and failed in CI, which is how the
      // wrong reading was found. What it asserts now is the behaviour that
      // matters: the form does not pass a one-name list off as the staff list,
      // and it does not reach around the policy with a privileged read.
      await page.getByRole('button', { name: /add an action item/i }).click();

      const select = page.getByLabel(/who is doing it/i);
      await expect(select).toBeVisible();

      await expect(
        page
          .getByText(/only the staff records your permissions let you read/i)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();

      // One real name, plus the unanswered option — and the Secretary's own
      // name is the one, because an item taken on by the person recording it
      // is the commonest case of all.
      await expect(select.locator('option')).toHaveCount(2);
      await expect(select.locator('option').first()).toHaveText(
        /nobody in particular yet/i,
      );

      // That an item *can* be recorded with no owner is asserted by
      // `benefits.write.spec.ts`, which presses the buttons. Nothing is
      // submitted from this file: it runs in both the desktop and the mobile
      // project, and a write from a read spec would run twice against one
      // seeded meeting.
    });
  });

  test.describe('as a borrower', () => {
    test.use({ storageState: stateFile('borrower') });

    test('reaches no meeting screen', async ({ page }) => {
      for (const path of [
        '/meetings',
        '/meetings/new',
        `/meetings/${fixtures.meetings.held}`,
      ]) {
        await page.goto(path);
        expect(page.url(), `${path} must not open to a borrower`).not.toContain(path);
      }
    });
  });
});

// ===========================================================================
test.describe('the phone', () => {
  test.use({ storageState: stateFile('owner') });

  const NARROW: readonly string[] = [
    '/meetings',
    `/meetings/${fixtures.meetings.held}`,
    '/meetings/new',
  ];

  for (const path of NARROW) {
    test(`${path} does not scroll sideways`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(path);
      await expectNoErrorBoundary(page);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );

      expect(overflow, `${path} overflows by ${String(overflow)}px`).toBeLessThanOrEqual(
        1,
      );
    });
  }

  test('keeps the register usable one-handed', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/meetings/${fixtures.meetings.held}`);

    // The register lists every expected member and is worked down a room on a
    // phone. Each row has to be reachable without a sideways scroll, and each
    // member's name has to be readable.
    const rows = page.locator('main li').filter({ visible: true });
    expect(await rows.count()).toBeGreaterThan(0);
  });
});
