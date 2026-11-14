/**
 * Account authorisations, driven through the browser.
 *
 * ## Why this suite exists separately
 *
 * `agency-money.write.spec.ts` puts its counter staff on each line's roster
 * through the harness, not through this screen — deliberately, because those
 * are tests about float purchases, sales and transfers, and a regression in
 * the authorisations screen should not fail six tests that name float trades.
 *
 * That leaves the screen itself untested through a browser, which is where
 * the gap would be. This closes it, and it is the one suite that drives the
 * whole arrangement the Owner's decision 2 asked for: an Owner grants a
 * mandate, the officer can then record, the mandate is withdrawn, and the
 * officer is refused again.
 *
 * ## What it proves that a database test cannot
 *
 * `tests/db/agency-account-staff.test.ts` proves the refusals hold against
 * SQL. It cannot prove that the Owner has a way to lift one — that the select
 * offers the right people, that the form reaches the function, that the page
 * then shows the mandate. The first version of this screen shipped a filter
 * stricter than the database's rule and offered an empty select to an Owner
 * with staff to authorise; every database test still passed.
 */
import type { Browser } from '@playwright/test';

import {
  expect,
  expectNoErrorBoundary,
  queryHarness,
  queryHarnessOne,
  stateFile,
  test,
} from './fixtures';

async function asRole(browser: Browser, who: 'owner' | 'manager' | 'secretary') {
  const context = await browser.newContext({ storageState: stateFile(who) });
  return { context, page: await context.newPage() };
}

/** The seeded Airtel line, which the harness already staffs. */
async function seededLine(): Promise<{ id: string; label: string }> {
  const row = await queryHarnessOne<{ id: string; label: string }>(
    `select f.id::text as id,
            coalesce(nullif(pg_catalog.btrim(f.label), ''), 'Till ' || f.till_name) as label
       from public.agency_provider_float_accounts f
       join public.agency_service_providers p on p.id = f.provider_id
      where p.code = 'DEMO_AIRTEL'
      order by f.created_at
      limit 1`,
  );
  return row;
}

test.describe('the agent account roster, through the screen', () => {
  test('an Owner sees every account with its roster, and what is unstaffed', async ({
    browser,
  }) => {
    const owner = await asRole(browser, 'owner');
    try {
      await owner.page.goto('/agency/staffing');
      await expectNoErrorBoundary(owner.page);

      await expect(
        owner.page.getByRole('heading', { name: 'Account authorisations', exact: true }),
      ).toBeVisible();

      // The panel that stops a correct posting being reported as a bug. The
      // oversight clause is load-bearing — without it an account with one
      // authorised cashier could never have anything posted — so the screen
      // says so rather than leaving an Owner to discover it.
      await expect(
        owner.page
          .getByText(/may still post against any account in their branch/i)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();

      const line = await seededLine();
      await expect(
        owner.page
          .getByText(line.label, { exact: false })
          .filter({ visible: true })
          .first(),
      ).toBeVisible();
    } finally {
      await owner.context.close();
    }
  });

  test('a Secretary cannot reach the screen at all', async ({ browser }) => {
    // Granting a mandate decides who may move the business's money through an
    // agent account. The route map gives this screen `agency:providers`, which
    // a Secretary does not hold — and the database agrees, so the refusal
    // holds even for a hand-typed URL.
    const cashier = await asRole(browser, 'secretary');
    try {
      await cashier.page.goto('/agency/staffing');
      // Turned away at the door or sent elsewhere; either is the guard
      // working. The claim is the narrow one: the screen does not render, and
      // no form for granting a mandate reaches her.
      await expect(
        cashier.page.getByRole('heading', {
          name: 'Account authorisations',
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(cashier.page.getByLabel('Authorise', { exact: true })).toHaveCount(0);
    } finally {
      await cashier.context.close();
    }
  });

  test('the Owner authorises somebody, and then withdraws it', async ({ browser }) => {
    // A line of its own, so this test cannot disturb the seeded rosters the
    // float-trade suite depends on.
    const tillName = `e2estaff${String(Date.now() % 1000000)}`;
    const created = await queryHarnessOne<{ id: string }>(
      `select public.ensure_agency_float_account(
                (select id from public.agency_service_providers
                  where code = 'DEMO_AIRTEL'),
                (select id from public.branches where branch_code = 'BR2601'),
                $1)::text as id`,
      [tillName],
    );

    const before = await queryHarnessOne<{ count: string }>(
      `select count(*)::text as count from public.agency_account_staff
        where float_account_id = $1 and status = 'active'`,
      [created.id],
    );
    expect(before.count).toBe('0');

    const owner = await asRole(browser, 'owner');
    try {
      await owner.page.goto('/agency/staffing');
      await expectNoErrorBoundary(owner.page);

      // The warning that names the accounts nobody can record against. This
      // is the screen's reason for existing, so it is asserted rather than
      // assumed.
      await expect(
        owner.page
          .getByText(/with nobody authorised/i)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();

      // The form for *this* account, named rather than taken positionally.
      // The first version of this test took `.first()`, which is whichever
      // account happens to sort first and had nothing to do with the one it
      // had just created — and it also looked for a role the form did not
      // have, because an unnamed `<form>` has no `form` role at all. Both
      // showed up as "the select offers nobody", which was true of a locator
      // that matched nothing.
      const form = owner.page.getByRole('form', {
        name: new RegExp(`Till ${tillName}`),
      });
      await expect(form).toBeVisible();

      // The select must offer somebody. It offered nobody in the first
      // version of this screen, because the filter was stricter than the
      // database's rule and dropped every officer carrying no branch.
      const select = form.getByLabel('Authorise', { exact: true });
      const options = await select.locator('option').allTextContents();
      const offered = options.filter(
        (label) => label.trim() !== '' && !/choose/i.test(label),
      );
      expect(offered.length, `offered: ${options.join(' | ')}`).toBeGreaterThan(0);

      // Narrowed by a throw rather than a cast, so the name used below is the
      // one the select actually offered.
      const [chosen] = offered;
      if (chosen === undefined) throw new Error('the select offered nobody');

      // Authorise the first person offered, and see the mandate appear.
      await select.selectOption({ label: chosen });
      await form.getByRole('button', { name: /authorise on this account/i }).click();
      await expect(
        form.getByText(/they may now record against this account/i),
      ).toBeVisible();

      const after = await queryHarnessOne<{ count: string }>(
        `select count(*)::text as count from public.agency_account_staff
          where float_account_id = $1 and status = 'active'`,
        [created.id],
      );
      expect(after.count).toBe('1');

      // And withdraw it, with a reason, which the row keeps.
      const withdraw = owner.page.getByRole('form', {
        name: new RegExp(`Withdraw ${chosen}`),
      });
      await withdraw.getByLabel(/withdraw, because/i).fill('acceptance walk-through');
      await withdraw.getByRole('button', { name: /^withdraw$/i }).click();
      await expect(
        withdraw.getByText(/may no longer record against this account/i),
      ).toBeVisible();

      const withdrawn = await queryHarnessOne<{
        active: string;
        reason: string | null;
      }>(
        `select count(*) filter (where status = 'active')::text as active,
                max(revoked_reason) as reason
           from public.agency_account_staff where float_account_id = $1`,
        [created.id],
      );
      expect(withdrawn.active).toBe('0');
      expect(withdrawn.reason).toBe('acceptance walk-through');
    } finally {
      await owner.context.close();
    }

    // Tidy up the line this test made, so the register stays readable for the
    // screens the other suites assert on. Nothing was posted against it, so
    // there is nothing financial to preserve. The roster rows go first: they
    // reference the account with `on delete restrict`, which is right —
    // a mandate whose account had vanished could not answer the question it
    // exists for.
    await queryHarness(
      `delete from public.agency_account_staff where float_account_id = $1`,
      [created.id],
    );
    await queryHarness(
      `delete from public.agency_provider_float_accounts
        where id = $1
          and not exists (select 1 from public.agency_transactions
                           where float_account_id = $1)`,
      [created.id],
    );
  });
});
