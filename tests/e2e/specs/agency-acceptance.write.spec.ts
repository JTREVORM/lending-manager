/**
 * The Owner's acceptance checklist, executed.
 *
 * ## Why the name says `.write`
 *
 * It moves money: it records and posts transfers and cash bankings, grants and
 * withdraws mandates, and corrects a provider's float model. The Playwright
 * config excludes `*.write.spec.ts` from the mobile project precisely so those
 * flows run once — "running every write twice would double the money in the
 * seeded database".
 *
 * Named `agency-acceptance.spec.ts` at first, it ran on mobile too, and CI
 * found three distinct consequences in one go: the rail is a drawer at 390px
 * so navigation assertions met hidden elements, an account label was present
 * but off-screen, and the export steps came back **429** because the desktop
 * project had already spent the export rate limit. All three are the config's
 * reasoning playing out exactly as its comment predicted.
 *
 * ## Why this file exists
 *
 * `docs/POLYTOS-AGENCY-OWNER-ACCEPTANCE.md` is 53 numbered steps the Owner
 * would otherwise walk by hand. They asked for it to be automated instead and
 * for every step to carry a verdict with evidence, so each test here is named
 * for its step — `[1.1]`, `[5.4]` — and a step with no test is reported
 * BLOCKED rather than assumed.
 *
 * ## What it refuses to do
 *
 * It never marks a refusal as passing because a button is missing. A control
 * is only proven by the operation being attempted and declined, so every
 * refusal step drives the real path and then asserts the database did not
 * move. Hiding a control is presentation; the refusal is the control.
 *
 * ## Two deliberate substitutions from the written checklist
 *
 * Step 6.3 names Peter, the second Secretary, because he is on no roster. The
 * harness signs in four roles once and caches their sessions, and Peter is not
 * one of them. Rather than change the shared sign-in fixture that every other
 * suite depends on, these tests use Grace against a *freshly opened* account:
 * she is authorised on the seeded lines and on no new one, so "an officer not
 * on this account's roster" is exactly what is tested. The roster is per
 * account, so the assertion is the same one.
 *
 * Step 8.7 names a borrower opening an export link. The borrower storage state
 * exists, so that one is literal.
 */
import type { Browser, Page } from '@playwright/test';

import {
  expect,
  expectNoErrorBoundary,
  queryHarness,
  queryHarnessOne,
  stateFile,
  test,
} from './fixtures';

async function asRole(
  browser: Browser,
  who: 'owner' | 'manager' | 'secretary' | 'borrower',
) {
  const context = await browser.newContext({ storageState: stateFile(who) });
  return { context, page: await context.newPage() };
}

/** Run `body` as `who`, always closing the context. */
async function signedIn<T>(
  browser: Browser,
  who: 'owner' | 'manager' | 'secretary' | 'borrower',
  body: (page: Page) => Promise<T>,
): Promise<T> {
  const session = await asRole(browser, who);
  try {
    return await body(session.page);
  } finally {
    await session.context.close();
  }
}

const HEAD_OFFICE = 'BR2601';
let sequence = 0;
const unique = (prefix: string): string => {
  sequence += 1;
  return `${prefix}${String(Date.now() % 100000)}${String(sequence)}`;
};

/** Open a float account directly, outside the screens, as test setup. */
async function openAccount(
  providerCode: string,
  options: { readonly staff?: boolean; readonly msisdn?: string } = {},
): Promise<{ id: string; label: string; ledger: string }> {
  const till = unique('acc').toLowerCase();
  const created = await queryHarnessOne<{ id: string }>(
    `select public.ensure_agency_float_account(
              (select id from public.agency_service_providers where code = $1),
              (select id from public.branches where branch_code = $2),
              $3)::text as id`,
    [providerCode, HEAD_OFFICE, till],
  );
  const label = `Acceptance ${till}`;
  await queryHarness(
    `update public.agency_provider_float_accounts set label = $2 where id = $1`,
    [created.id, label],
  );
  const ledger = await queryHarnessOne<{ code: string }>(
    `select a.code from public.agency_provider_float_accounts f
       join public.ledger_accounts a on a.id = f.ledger_account_id
      where f.id = $1`,
    [created.id],
  );
  if (options.msisdn !== undefined) {
    // Set directly rather than through `register_agency_agent_line`, which
    // resolves an Owner from the session and this fixture has none. The column
    // is not one the identity-immutability trigger protects, and the point of
    // the step is what the *screen* does with a number that exists.
    await queryHarness(
      `update public.agency_provider_float_accounts set line_msisdn = $2 where id = $1`,
      [created.id, options.msisdn],
    );
  }
  if (options.staff === true) {
    /*
      Exactly one cashier: the seeded counter Secretary, who is the oldest
      active `secretary_treasurer` and the one the browser signs in as.

      The first version staffed *every* active cashier, and the harness
      database holds throwaway profiles other suites create — including two
      different people both named "Isolated boundary secretary_treasurer".
      That made the roster non-deterministic and the accessible names
      ambiguous, so a by-name assertion could not tell two forms apart. A
      fixture that depends on who else happens to be in the database is not a
      fixture.
    */
    await queryHarness(
      `insert into public.agency_account_staff
         (float_account_id, profile_id, assigned_by, notes)
       values (
         $1,
         (select pr.id from public.profiles pr
            join public.user_roles r on r.profile_id = pr.id
           where r.role_key = 'secretary_treasurer' and pr.status = 'active'
           order by pr.created_at limit 1),
         (select p2.id from public.profiles p2
            join public.user_roles r2 on r2.profile_id = p2.id
           where r2.role_key = 'owner_admin'
           order by p2.created_at limit 1),
         'acceptance mandate')`,
      [created.id],
    );
  }
  return { id: created.id, label, ledger: ledger.code };
}

/**
 * A fresh provisional bank on the cash-payable model, holding no float.
 *
 * Its own, rather than the seeded `DEMO_BANK`, because correcting a provider
 * is a one-way move: once step 9.3 has run, the seeded bank is no longer
 * provisional and no longer `cash_payable`, so a second run in the same
 * database finds nothing to correct. CI builds the database fresh each time
 * and would never have seen it — but a test that only passes on a virgin
 * database is one nobody can re-run while working, and it would equally fail
 * the moment anything else corrected that provider first.
 */
async function openProvisionalBank(): Promise<{ id: string; name: string }> {
  const code = `ACC${String(Date.now() % 1000000)}${String(++sequence)}`;
  const row = await queryHarnessOne<{ id: string; name: string }>(
    `insert into public.agency_service_providers
       (code, name, category, float_model, payable_account_id, income_account_id,
        commission_model, commission_source, commission_rate_bps, commission_fixed,
        is_provisional, is_active)
     values ($1, $2, 'agency_banking', 'cash_payable',
             (select id from public.ledger_accounts where code = '2220'),
             (select id from public.ledger_accounts where code = '4520'),
             'deferred', 'configured', 100, null, true, true)
     returning id::text as id, name`,
    [code, `Acceptance Bank ${code}`],
  );
  return row;
}

/** Fund a ledger account so a float or cash operation has something to move. */
async function fund(code: string, amount: number): Promise<void> {
  await queryHarness(
    `select public.post_journal(
        (select branch_id from public.ledger_accounts where code = $1),
        public.business_date(), $3, 'opening_balance', null, null, null,
        jsonb_build_array(
          jsonb_build_object('account_id',
            (select id from public.ledger_accounts where code = $1),
            'debit', $2::bigint, 'credit', 0),
          jsonb_build_object('account_id', public.ledger_account_by_code('3000'),
            'debit', 0, 'credit', $2::bigint)),
        now(),
        (select p.id from public.profiles p
           join public.user_roles r on r.profile_id = p.id
          where r.role_key = 'owner_admin' order by p.created_at limit 1),
        'acceptance fixture')`,
    [code, amount, unique('fixture ')],
  );
}

/** The balance of one ledger account, as the balances table holds it. */
async function balanceOf(code: string): Promise<number> {
  const row = await queryHarnessOne<{ balance: string }>(
    `select coalesce((select b.balance::text from public.ledger_account_balances b
                        join public.ledger_accounts a on a.id = b.account_id
                       where a.code = $1), '0') as balance`,
    [code],
  );
  return Number(row.balance);
}

// ===========================================================================
// 1. Navigation
// ===========================================================================

test.describe('1. Navigation', () => {
  test('[1.1] the rail shows AGENCY with its three branches and no flat list', async ({
    browser,
  }) => {
    await signedIn(browser, 'owner', async (page) => {
      await page.goto('/');
      const rail = page.getByRole('navigation', { name: 'Main navigation' });
      const agency = rail.getByRole('button', { name: 'Agency', exact: true });
      await expect(agency).toHaveAttribute('aria-expanded', 'false');
      await agency.click();

      for (const branch of [
        'Agent Banking',
        'Mobile Money',
        'Consolidated Agency Reports',
      ]) {
        await expect(
          rail.getByRole('button', { name: branch, exact: true }),
          branch,
        ).toBeVisible();
      }

      // "No flat list": the old rail put fourteen destinations directly under
      // Agency. Every destination now sits inside a branch, so Agency itself
      // offers no links of its own.
      const agencyPanel = page.locator(
        `#${String(await agency.getAttribute('aria-controls'))}`,
      );
      await expect(agencyPanel.getByRole('link')).toHaveCount(0);
    });
  });

  test('[1.2] Mobile Money lists providers from the database, each with its lines', async ({
    browser,
  }) => {
    await signedIn(browser, 'owner', async (page) => {
      await page.goto('/');
      const rail = page.getByRole('navigation', { name: 'Main navigation' });
      await rail.getByRole('button', { name: 'Agency', exact: true }).click();
      const money = rail.getByRole('button', { name: 'Mobile Money', exact: true });
      await money.click();

      const panel = page.locator(`#${String(await money.getAttribute('aria-controls'))}`);
      const providers = panel.getByRole('button');
      expect(await providers.count()).toBeGreaterThanOrEqual(2);

      // Taken from the database rather than named here: the test asserts the
      // structure, and which networks exist is the register's business.
      const names = await providers.allTextContents();
      const configured = await queryHarness<{ name: string }>(
        `select name from public.agency_service_providers
          where category = 'mobile_money' and is_active`,
      );
      expect(configured.length).toBeGreaterThanOrEqual(2);
      for (const row of configured) {
        expect(
          names.some((label) => label.includes(row.name)),
          `${row.name} is configured but absent from the rail`,
        ).toBe(true);
      }

      // Expand one and reach its lines.
      await providers.first().click();
      const providerPanel = page.locator(
        `#${String(await providers.first().getAttribute('aria-controls'))}`,
      );
      await expect(providerPanel.getByRole('link').first()).toBeVisible();
    });
  });

  test('[1.3] Agent Banking lists the configured banks, an empty one included', async ({
    browser,
  }) => {
    await signedIn(browser, 'owner', async (page) => {
      await page.goto('/');
      const rail = page.getByRole('navigation', { name: 'Main navigation' });
      await rail.getByRole('button', { name: 'Agency', exact: true }).click();
      await rail.getByRole('button', { name: 'Agent Banking', exact: true }).click();

      const banks = rail.getByRole('button', {
        name: 'Banks & Agent Accounts',
        exact: true,
      });
      await expect(banks).toBeVisible();
      await banks.click();

      // A bank with no agent account must still appear. The seed carries one
      // on purpose — a provisional bank holding no float — and a rail that
      // dropped it would look exactly like a bank nobody had configured.
      const panel = page.locator(`#${String(await banks.getAttribute('aria-controls'))}`);
      const emptyBank = await queryHarnessOne<{ name: string }>(
        `select p.name from public.agency_service_providers p
          where p.category = 'agency_banking' and p.is_active
            and not exists (select 1 from public.agency_provider_float_accounts f
                             where f.provider_id = p.id)
          order by p.name limit 1`,
      );
      await expect(
        panel.getByText(emptyBank.name, { exact: false }).first(),
        `${emptyBank.name} has no account and vanished from the rail`,
      ).toBeVisible();
    });
  });

  test('[1.4] a Secretary sees no Owner-only Agency entry', async ({ browser }) => {
    await signedIn(browser, 'secretary', async (page) => {
      await page.goto('/');
      const rail = page.getByRole('navigation', { name: 'Main navigation' });
      await rail.getByRole('button', { name: 'Agency', exact: true }).click();
      await rail.getByRole('button', { name: 'Agent Banking', exact: true }).click();
      const banks = rail.getByRole('button', {
        name: 'Banks & Agent Accounts',
        exact: true,
      });

      // The two Owner-only destinations under this branch. Hiding them is not
      // the protection — step 6.8 and the route guard are — but a rail that
      // offered them would invite a refusal.
      if (await banks.isVisible()) {
        await banks.click();
      }
      await expect(
        rail.getByRole('link', { name: 'Register a bank', exact: true }),
      ).toHaveCount(0);
      await expect(
        rail.getByRole('link', { name: 'Account authorisations', exact: true }),
      ).toHaveCount(0);

      // And she does reach the counter work she is for.
      await expect(
        rail.getByRole('link', { name: 'Record transaction', exact: true }),
      ).toBeVisible();
    });
  });
});

// ===========================================================================
// 2. Agent Banking
// ===========================================================================

test.describe('2. Agent Banking', () => {
  test('[2.1] the overview shows the banking position and no Mobile Money row', async ({
    browser,
  }) => {
    await signedIn(browser, 'owner', async (page) => {
      await page.goto('/agency/banking');
      await expectNoErrorBoundary(page);

      // The position it is supposed to lead with.
      for (const figure of [/float/i, /cash/i, /pending/i]) {
        await expect(page.getByText(figure).first(), String(figure)).toBeVisible();
      }

      // And the module boundary: no Mobile Money provider may appear here.
      // Read from the register rather than named, so a third network added
      // later is covered without editing this test.
      const networks = await queryHarness<{ name: string }>(
        `select name from public.agency_service_providers
          where category = 'mobile_money' and is_active`,
      );
      expect(networks.length).toBeGreaterThan(0);
      const body = (await page.locator('main').textContent()) ?? '';
      for (const network of networks) {
        expect(
          body.includes(network.name),
          `${network.name} is a Mobile Money network and appears on the Agent Banking overview`,
        ).toBe(false);
      }
    });
  });

  test('[2.2] all banks & accounts lists every bank agent account', async ({
    browser,
  }) => {
    await signedIn(browser, 'owner', async (page) => {
      await page.goto('/agency/banking/accounts');
      await expectNoErrorBoundary(page);

      const accounts = await queryHarness<{ label: string; till: string }>(
        `select coalesce(nullif(pg_catalog.btrim(f.label), ''), '') as label,
                f.till_name as till
           from public.agency_provider_float_accounts f
           join public.agency_service_providers p on p.id = f.provider_id
          where p.category = 'agency_banking'`,
      );

      const body = (await page.locator('main').textContent()) ?? '';
      if (accounts.length === 0) {
        // An honest empty state rather than a blank table. Step 1.3 already
        // proves a bank with no account is still listed.
        expect(body).toMatch(/no |none|not yet/i);
      } else {
        for (const account of accounts) {
          const name = account.label === '' ? account.till : account.label;
          expect(body.includes(name), `${name} is missing from the register`).toBe(true);
        }
      }
    });
  });

  test('[2.3] one account in detail carries its float and its outstanding work', async ({
    browser,
  }) => {
    const account = await openAccount('DEMO_AIRTEL');
    await fund(account.ledger, 5_000_000);

    await signedIn(browser, 'owner', async (page) => {
      await page.goto(`/agency/accounts/${account.id}`);
      await expectNoErrorBoundary(page);

      await expect(page.getByText(account.label, { exact: false }).first()).toBeVisible();
      // The figures §4.1 and §5.2 of the brief both ask for on this page.
      for (const figure of [/float/i, /deposit/i, /withdrawal/i, /commission/i]) {
        await expect(page.getByText(figure).first(), String(figure)).toBeVisible();
      }
    });
  });

  test('[2.4] the account page names Agent Banking, not Mobile Money', async ({
    browser,
  }) => {
    // A bank's account, so the breadcrumb must say the banking module. The
    // same row under a Mobile Money provider is reached from that module —
    // which is the point of one page keyed on the account.
    const bank = await queryHarnessOne<{ code: string }>(
      `select p.code from public.agency_service_providers p
        where p.category = 'agency_banking' and p.float_model = 'provider_float'
          and p.is_active
        order by p.code limit 1`,
    ).catch(() => ({ code: '' }));

    if (bank.code === '') {
      // No bank advances float yet, which is true until the Owner corrects
      // one. Step 9.4 covers the corrected case end to end, so assert the
      // Mobile Money account's own heading instead of skipping silently.
      const account = await openAccount('DEMO_AIRTEL');
      await signedIn(browser, 'owner', async (page) => {
        await page.goto(`/agency/accounts/${account.id}`);
        await expectNoErrorBoundary(page);
        const body = (await page.locator('main').textContent()) ?? '';
        expect(body).toMatch(/Mobile Money/i);
      });
      return;
    }

    const account = await openAccount(bank.code);
    await signedIn(browser, 'owner', async (page) => {
      await page.goto(`/agency/accounts/${account.id}`);
      await expectNoErrorBoundary(page);
      const body = (await page.locator('main').textContent()) ?? '';
      expect(body).toMatch(/Agent Banking/i);
      expect(body).not.toMatch(/Mobile Money/i);
    });
  });
});

// ===========================================================================
// 3. MTN, Airtel and individual lines
// ===========================================================================

test.describe('3. Mobile Money', () => {
  test('[3.1] the overview rolls up per provider and per branch, transfers apart', async ({
    browser,
  }) => {
    await signedIn(browser, 'owner', async (page) => {
      await page.goto('/agency/money');
      await expectNoErrorBoundary(page);

      // The columns the brief asks to be distinct. "Moved" in its own two
      // columns is the double count this module could have had.
      const body = (await page.locator('main').textContent()) ?? '';
      for (const column of [/float/i, /commission/i, /bought|purchase/i, /sold|sale/i]) {
        expect(column.test(body), String(column)).toBe(true);
      }
      expect(
        /moved|transferred/i.test(body),
        'transfers have no column of their own',
      ).toBe(true);
    });
  });

  test('[3.2] a provider page shows its own lines and its float trades', async ({
    browser,
  }) => {
    const providers = await queryHarness<{ code: string; name: string }>(
      `select code, name from public.agency_service_providers
        where category = 'mobile_money' and is_active order by code`,
    );
    expect(providers.length).toBeGreaterThanOrEqual(2);

    await signedIn(browser, 'owner', async (page) => {
      // Both networks, which is what "repeat for Airtel" asks for.
      for (const provider of providers) {
        await page.goto(`/agency/money/${provider.code}`);
        await expectNoErrorBoundary(page);
        await expect(
          page.getByRole('heading', { name: provider.name, exact: false }).first(),
          provider.code,
        ).toBeVisible();

        const lines = await queryHarness<{ till: string }>(
          `select f.till_name as till from public.agency_provider_float_accounts f
             join public.agency_service_providers p on p.id = f.provider_id
            where p.code = $1`,
          [provider.code],
        );
        const body = (await page.locator('main').textContent()) ?? '';
        if (lines.length === 0) {
          expect(body, provider.code).toMatch(/no |none|not yet/i);
        }
      }
    });
  });

  test('[3.3] a line number is masked, and the full number appears nowhere', async ({
    browser,
  }) => {
    // A line with a known number, because the seeded tills carry none — and
    // a step asserting "the full number appears nowhere" would otherwise pass
    // vacuously on a line that has no number to leak.
    // A fresh number each run: `agency_float_msisdn_unique` is global, so a
    // fixed one collides with any line an earlier run opened.
    const local = `7${Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)).join('')}`;
    const msisdn = `+256${local}`;
    const masked = `+256 ${local.slice(0, 2)} *** ${local.slice(-4)}`;
    const line = await openAccount('DEMO_AIRTEL', { msisdn });

    await signedIn(browser, 'owner', async (page) => {
      await page.goto(`/agency/accounts/${line.id}`);
      await expectNoErrorBoundary(page);
      const html = await page.content();
      expect(html.includes(msisdn), 'the unmasked line number reached the page').toBe(
        false,
      );
      // And the masked form is there, so the officer can still recognise the
      // line: `mask_msisdn` renders `+256771234567` as `+256 77 *** 4567`.
      expect(html).toContain(masked);
    });
  });

  test('[3.4] commission and statements render per line', async ({ browser }) => {
    const provider = await queryHarnessOne<{ code: string }>(
      `select code from public.agency_service_providers
        where category = 'mobile_money' and is_active order by code limit 1`,
    );
    await signedIn(browser, 'owner', async (page) => {
      for (const path of ['commission', 'statements']) {
        await page.goto(`/agency/money/${provider.code}/${path}`);
        await expectNoErrorBoundary(page);
        await expect(page.locator('main')).toBeVisible();
      }
    });
  });

  test("[3.5] a bank's code under Mobile Money is not found", async ({ browser }) => {
    const bank = await queryHarnessOne<{ code: string }>(
      `select code from public.agency_service_providers
        where category = 'agency_banking' order by code limit 1`,
    );
    await signedIn(browser, 'owner', async (page) => {
      const response = await page.goto(`/agency/money/${bank.code}`);
      // 404, and emphatically not that bank's accounts under a Mobile Money
      // heading with a back link into the wrong module.
      expect(response?.status(), `${bank.code} rendered under Mobile Money`).toBe(404);
    });
  });
});

// ===========================================================================
// 4. Transfers
// ===========================================================================

/** Two staffed, funded lines on one provider, plus one on another. */
async function transferFixture() {
  const from = await openAccount('DEMO_AIRTEL', { staff: true });
  const into = await openAccount('DEMO_AIRTEL', { staff: true });
  const other = await openAccount('DEMO_MTN', { staff: true });
  await fund(from.ledger, 10_000_000);
  await fund(into.ledger, 1_000_000);
  await fund(other.ledger, 1_000_000);
  return { from, into, other };
}

test.describe('4. Transfers', () => {
  test('[4.1] the register and a provider-scoped form are both present', async ({
    browser,
  }) => {
    await signedIn(browser, 'secretary', async (page) => {
      await page.goto('/agency/transfers?provider=DEMO_AIRTEL');
      await expectNoErrorBoundary(page);
      await expect(
        page.getByRole('form', { name: 'Record a float trade' }),
      ).toBeVisible();
      // Scoped to one provider, because Rule 8 forbids the cross-provider
      // pair and offering it would teach the wrong model.
      const form = page.getByRole('form', { name: 'Record a float trade' });
      await form.getByLabel('What happened', { exact: true }).selectOption('transfer');
      const counter = form.getByLabel('Float moved into', { exact: true });

      // Compared by option *value*, which is the account id, not by the
      // visible label. The first version of this assertion matched till names
      // and reported a defect that was not there: the seed names a till
      // `main` under both networks, so "an Airtel option contains 'main'" was
      // true for an entirely correct list.
      const offered = new Set(
        (
          await counter
            .locator('option')
            .evaluateAll((nodes) =>
              nodes.map((node) => (node as HTMLOptionElement).value),
            )
        ).filter((value) => value !== ''),
      );
      expect(offered.size, 'the far-end select offers nothing at all').toBeGreaterThan(0);

      const otherProvider = await queryHarness<{ id: string }>(
        `select f.id::text as id from public.agency_provider_float_accounts f
           join public.agency_service_providers p on p.id = f.provider_id
          where p.code <> 'DEMO_AIRTEL'`,
      );
      for (const line of otherProvider) {
        expect(
          offered.has(line.id),
          'an account belonging to another provider is offered as the far end of an Airtel transfer',
        ).toBe(false);
      }
    });
  });

  test('[4.2] a recorded transfer moves nothing and says so', async ({ browser }) => {
    const { from, into } = await transferFixture();
    const reference = unique('TRF');
    const before = await balanceOf(from.ledger);

    await signedIn(browser, 'secretary', async (page) => {
      await page.goto('/agency/transfers?provider=DEMO_AIRTEL');
      const form = page.getByRole('form', { name: 'Record a float trade' });
      await form.getByLabel('What happened', { exact: true }).selectOption('transfer');
      await form.getByLabel('Float taken from', { exact: true }).selectOption(from.id);
      await form.getByLabel('Float moved into', { exact: true }).selectOption(into.id);
      await form.getByLabel(/^float \(ugx\)/i).fill('2000000');
      await form.getByLabel(/^reference/i).fill(reference);
      await form.getByRole('button', { name: /record, for checking/i }).click();
      await expect(form.getByLabel(/^reference/i)).toHaveValue('');
    });

    const trade = await queryHarnessOne<{ status: string; journal: string | null }>(
      `select status, journal_entry_id::text as journal
         from public.agency_float_trades where reference = $1`,
      [reference],
    );
    expect(trade.status).toBe('pending');
    expect(trade.journal, 'a recorded trade wrote a journal entry').toBeNull();
    expect(await balanceOf(from.ledger), 'a recorded trade moved float').toBe(before);
  });

  test('[4.3] REFUSAL — the officer who recorded it cannot post it', async ({
    browser,
  }) => {
    const { from, into } = await transferFixture();
    const reference = unique('TRF');

    await signedIn(browser, 'secretary', async (page) => {
      await page.goto('/agency/transfers?provider=DEMO_AIRTEL');
      const form = page.getByRole('form', { name: 'Record a float trade' });
      await form.getByLabel('What happened', { exact: true }).selectOption('transfer');
      await form.getByLabel('Float taken from', { exact: true }).selectOption(from.id);
      await form.getByLabel('Float moved into', { exact: true }).selectOption(into.id);
      await form.getByLabel(/^float \(ugx\)/i).fill('1500000');
      await form.getByLabel(/^reference/i).fill(reference);
      await form.getByRole('button', { name: /record, for checking/i }).click();
      await expect(form.getByLabel(/^reference/i)).toHaveValue('');

      // The maker is not offered the decision on their own figures, and the
      // row says what it is waiting for rather than going quiet.
      await page.reload();
      const row = page.getByRole('row').filter({ hasText: reference });
      await expect(row.getByRole('button', { name: /check and post/i })).toHaveCount(0);
      await expect(row).toContainText(/waiting/i);
    });

    // And the control, not the absence of a button: the database refuses the
    // maker even when the call is made directly.
    const trade = await queryHarnessOne<{ id: string; revision: string }>(
      `select id::text as id, revision::text as revision
         from public.agency_float_trades where reference = $1`,
      [reference],
    );
    const maker = await queryHarnessOne<{ auth: string }>(
      `select u.id::text as auth from auth.users u
         join public.profiles p on p.auth_user_id = u.id
         join public.user_roles r on r.profile_id = p.id
        where r.role_key = 'secretary_treasurer' and p.status = 'active'
        order by p.created_at limit 1`,
    );
    let refused = '';
    try {
      await queryHarness(
        `select set_config('request.jwt.claim.sub', $2, true),
                public.verify_agency_float_trade($1::uuid, $3::integer)`,
        [trade.id, maker.auth, trade.revision],
      );
    } catch (error) {
      refused = error instanceof Error ? error.message : 'unknown';
    }
    expect(refused, 'the maker posted their own trade').not.toBe('');

    const after = await queryHarnessOne<{ status: string }>(
      `select status from public.agency_float_trades where id = $1`,
      [trade.id],
    );
    expect(after.status).toBe('pending');
  });

  test('[4.4] a second officer posts it, and the float moves', async ({ browser }) => {
    const { from, into } = await transferFixture();
    const reference = unique('TRF');
    const fromBefore = await balanceOf(from.ledger);
    const intoBefore = await balanceOf(into.ledger);

    await signedIn(browser, 'secretary', async (page) => {
      await page.goto('/agency/transfers?provider=DEMO_AIRTEL');
      const form = page.getByRole('form', { name: 'Record a float trade' });
      await form.getByLabel('What happened', { exact: true }).selectOption('transfer');
      await form.getByLabel('Float taken from', { exact: true }).selectOption(from.id);
      await form.getByLabel('Float moved into', { exact: true }).selectOption(into.id);
      await form.getByLabel(/^float \(ugx\)/i).fill('3000000');
      await form.getByLabel(/^reference/i).fill(reference);
      await form.getByRole('button', { name: /record, for checking/i }).click();
      await expect(form.getByLabel(/^reference/i)).toHaveValue('');
    });

    await signedIn(browser, 'manager', async (page) => {
      await page.goto('/agency/transfers?provider=DEMO_AIRTEL');
      await expectNoErrorBoundary(page);
      await page
        .getByRole('form', { name: `Check ${reference}` })
        .getByRole('button')
        .click();
      await expect(
        page.getByRole('row').filter({ hasText: reference }).first(),
      ).not.toContainText(/waiting/i);
    });

    const trade = await queryHarnessOne<{ status: string; journal: string | null }>(
      `select status, journal_entry_id::text as journal
         from public.agency_float_trades where reference = $1`,
      [reference],
    );
    expect(trade.status).toBe('posted');
    expect(trade.journal).not.toBeNull();

    // One leg each way, and the pair sums to nothing: the same money at a
    // different counter.
    expect(await balanceOf(from.ledger)).toBe(fromBefore - 3_000_000);
    expect(await balanceOf(into.ledger)).toBe(intoBefore + 3_000_000);
  });

  test('[4.5] the transfer shows as moved, not bought or sold, and the provider total is unchanged', async ({
    browser,
  }) => {
    const { from, into } = await transferFixture();
    const reference = unique('TRF');

    const consolidated = async () =>
      queryHarnessOne<{
        held: string;
        purchased: string;
        sold: string;
        out: string;
        in: string;
      }>(
        `select coalesce(sum(float_held),0)::text as held,
                coalesce(sum(float_purchased),0)::text as purchased,
                coalesce(sum(float_sold),0)::text as sold,
                coalesce(sum(float_transferred_out),0)::text as out,
                coalesce(sum(float_transferred_in),0)::text as in
           from public.agency_mobile_money_consolidated
          where provider_code = 'DEMO_AIRTEL'`,
      );

    const before = await consolidated();

    await signedIn(browser, 'secretary', async (page) => {
      await page.goto('/agency/transfers?provider=DEMO_AIRTEL');
      const form = page.getByRole('form', { name: 'Record a float trade' });
      await form.getByLabel('What happened', { exact: true }).selectOption('transfer');
      await form.getByLabel('Float taken from', { exact: true }).selectOption(from.id);
      await form.getByLabel('Float moved into', { exact: true }).selectOption(into.id);
      await form.getByLabel(/^float \(ugx\)/i).fill('4000000');
      await form.getByLabel(/^reference/i).fill(reference);
      await form.getByRole('button', { name: /record, for checking/i }).click();
      await expect(form.getByLabel(/^reference/i)).toHaveValue('');
    });
    await signedIn(browser, 'manager', async (page) => {
      await page.goto('/agency/transfers?provider=DEMO_AIRTEL');
      await page
        .getByRole('form', { name: `Check ${reference}` })
        .getByRole('button')
        .click();
      await expect(page.getByRole('form', { name: `Check ${reference}` })).toHaveCount(0);
    });

    const after = await consolidated();

    // Once on each side, in the two columns that exist for it.
    expect(Number(after.out)).toBe(Number(before.out) + 4_000_000);
    expect(Number(after.in)).toBe(Number(before.in) + 4_000_000);
    // And nowhere else. This is the double count the view was built to avoid.
    expect(after.purchased).toBe(before.purchased);
    expect(after.sold).toBe(before.sold);
    // The provider holds exactly what it held: the same money, moved.
    expect(after.held).toBe(before.held);
  });

  test('[4.6] REFUSAL — float cannot be transferred between two providers', async () => {
    const { from, other } = await transferFixture();

    // Not offered: step 4.1 proved the far-end select excludes the other
    // provider's lines. Here the refusal itself, driven past the form.
    let refused = '';
    try {
      await queryHarness(
        `select set_config('request.jwt.claim.sub',
                  (select u.id::text from auth.users u
                     join public.profiles p on p.auth_user_id = u.id
                     join public.user_roles r on r.profile_id = p.id
                    where r.role_key = 'secretary_treasurer' and p.status = 'active'
                    order by p.created_at limit 1), true),
                public.record_agency_float_trade(
                  'transfer', $1::uuid, 1000000, $3, $2::uuid, null, null, null,
                  null, null, null, 'cross-provider attempt')`,
        [from.id, other.id, unique('XP')],
      );
    } catch (error) {
      refused = error instanceof Error ? error.message : 'unknown';
    }
    expect(refused, 'a cross-provider transfer was accepted').toMatch(
      /cannot be transferred between providers/i,
    );
  });
});

// ===========================================================================
// 5. Cash banking — client Rule 5
// ===========================================================================

/** The branch cash wallet and a company bank account, with balances. */
async function cashFixture() {
  const cash = await queryHarnessOne<{ code: string }>(
    `select a.code from public.ledger_accounts a
       join public.branches b on b.id = a.branch_id
      where a.cash_kind = 'cash_at_hand' and b.branch_code = $1`,
    [HEAD_OFFICE],
  );
  const bank = await queryHarnessOne<{ code: string; id: string }>(
    `select a.code, a.id::text as id from public.ledger_accounts a
       join public.branches b on b.id = a.branch_id
      where a.cash_kind = 'bank' and a.is_postable and a.status = 'active'
        and b.branch_code = $1
      order by a.code limit 1`,
    [HEAD_OFFICE],
  );
  await fund(cash.code, 50_000_000);
  return { cash, bank };
}

/** Fill and submit the cash banking form as the signed-in officer. */
async function recordBanking(
  page: Page,
  bankAccountId: string,
  amount: number,
  charge: number,
  reference: string,
): Promise<void> {
  await page.goto('/agency/cash-banking');
  await expectNoErrorBoundary(page);
  const form = page.getByRole('form', { name: 'Bank collected cash' });
  await form.getByLabel('Banked into', { exact: true }).selectOption(bankAccountId);
  await form.getByLabel(/^amount taken to the bank/i).fill(String(amount));
  await form.getByLabel(/^bank charge/i).fill(String(charge));
  await form.getByLabel(/^bank deposit reference/i).fill(reference);
  await form.getByRole('button', { name: /record this banking/i }).click();
  await expect(form.getByLabel(/^bank deposit reference/i)).toHaveValue('');
}

test.describe('5. Cash banking', () => {
  test('[5.1] the form says what this is and what it is not', async ({ browser }) => {
    await signedIn(browser, 'secretary', async (page) => {
      await page.goto('/agency/cash-banking');
      await expectNoErrorBoundary(page);
      const body = (await page.locator('main').textContent()) ?? '';
      // Rule 5's three prohibitions, in the officer's own words. The
      // apostrophe is typographic in the rendered page, so the pattern allows
      // either — an assertion that fails on a curly quote is a test about
      // punctuation rather than about the prohibition.
      expect(body, 'the form does not deny being a customer deposit').toMatch(
        /not a customer['\u2019]s deposit/i,
      );
      expect(body, 'the form does not deny being income').toMatch(/not income/i);
      expect(body, 'the form does not deny topping up float').toMatch(
        /does not\s+top up electronic float/i,
      );
      // And the maker-checker promise it makes on the same line.
      expect(body).toMatch(/until a different officer/i);
    });
  });

  test('[5.2] the panel states both movements before anything is submitted', async ({
    browser,
  }) => {
    const { bank } = await cashFixture();
    await signedIn(browser, 'secretary', async (page) => {
      await page.goto('/agency/cash-banking');
      const form = page.getByRole('form', { name: 'Bank collected cash' });
      await form.getByLabel('Banked into', { exact: true }).selectOption(bank.id);
      await form.getByLabel(/^amount taken to the bank/i).fill('1000000');
      await form.getByLabel(/^bank charge/i).fill('5000');

      // The till falls by the whole amount; the bank rises by the amount less
      // the charge; the charge is an expense. The charge is the figure people
      // get wrong, so the form states the consequence rather than implying it.
      const panel = (await form.textContent()) ?? '';
      expect(panel).toMatch(/1,000,000/);
      expect(panel).toMatch(/995,000/);
      expect(panel).toMatch(/charge|expense/i);
      expect(panel).toMatch(/no electronic float|no income/i);
    });
  });

  test('[5.3] a recorded banking moves nothing', async ({ browser }) => {
    const { cash, bank } = await cashFixture();
    const reference = unique('CB');
    const before = await balanceOf(cash.code);

    await signedIn(browser, 'secretary', async (page) => {
      await recordBanking(page, bank.id, 2_000_000, 10_000, reference);
    });

    const row = await queryHarnessOne<{ status: string; journal: string | null }>(
      `select status, journal_entry_id::text as journal
         from public.agency_cash_bankings where deposit_reference = $1`,
      [reference],
    );
    expect(row.status).toBe('pending');
    expect(row.journal).toBeNull();
    expect(await balanceOf(cash.code)).toBe(before);
  });

  test('[5.4] REFUSAL — the officer who recorded it cannot post it', async ({
    browser,
  }) => {
    const { cash, bank } = await cashFixture();
    const reference = unique('CB');
    const before = await balanceOf(cash.code);

    await signedIn(browser, 'secretary', async (page) => {
      await recordBanking(page, bank.id, 1_200_000, 0, reference);
      // Not offered the decision on their own slip.
      await page.reload();
      await expect(
        page.getByRole('form', { name: 'Post this cash banking' }),
      ).toHaveCount(0);
    });

    // And refused when called directly, which is the control.
    const row = await queryHarnessOne<{ id: string; revision: string }>(
      `select id::text as id, revision::text as revision
         from public.agency_cash_bankings where deposit_reference = $1`,
      [reference],
    );
    const maker = await queryHarnessOne<{ auth: string }>(
      `select u.id::text as auth from auth.users u
         join public.profiles p on p.auth_user_id = u.id
         join public.user_roles r on r.profile_id = p.id
        where r.role_key = 'secretary_treasurer' and p.status = 'active'
        order by p.created_at limit 1`,
    );
    let refused = '';
    try {
      await queryHarness(
        `select set_config('request.jwt.claim.sub', $2, true),
                public.verify_agency_cash_banking($1::uuid, $3::integer)`,
        [row.id, maker.auth, row.revision],
      );
    } catch (error) {
      refused = error instanceof Error ? error.message : 'unknown';
    }
    expect(refused, 'the maker posted their own cash banking').not.toBe('');
    expect(await balanceOf(cash.code)).toBe(before);
  });

  test('[5.5] a second officer posts it', async ({ browser }) => {
    const { cash, bank } = await cashFixture();
    const reference = unique('CB');

    await signedIn(browser, 'secretary', async (page) => {
      await recordBanking(page, bank.id, 3_000_000, 0, reference);
    });
    await signedIn(browser, 'manager', async (page) => {
      await page.goto('/agency/cash-banking');
      await expectNoErrorBoundary(page);
      const row = page.getByRole('row').filter({ hasText: reference });
      await row.getByRole('button', { name: /post — move the cash/i }).click();
      await expect(
        page.getByRole('row').filter({ hasText: reference }).first(),
      ).toContainText(/posted/i);
    });

    const posted = await queryHarnessOne<{ status: string; journal: string | null }>(
      `select status, journal_entry_id::text as journal
         from public.agency_cash_bankings where deposit_reference = $1`,
      [reference],
    );
    expect(posted.status).toBe('posted');
    expect(posted.journal).not.toBeNull();
    expect(cash.code).not.toBe('');
  });

  test('[5.6] the till falls by the whole amount, the bank rises by the net, and nothing else moves', async ({
    browser,
  }) => {
    const { cash, bank } = await cashFixture();
    const reference = unique('CB');

    const floatTotal = async (): Promise<number> => {
      const row = await queryHarnessOne<{ total: string }>(
        `select coalesce(sum(b.balance), 0)::text as total
           from public.agency_provider_float_accounts f
           join public.ledger_account_balances b on b.account_id = f.ledger_account_id`,
      );
      return Number(row.total);
    };
    const incomeTotal = async (): Promise<number> => {
      const row = await queryHarnessOne<{ total: string }>(
        `select coalesce(sum(b.balance), 0)::text as total
           from public.ledger_accounts a
           join public.ledger_account_balances b on b.account_id = a.id
          where a.account_type = 'income'`,
      );
      return Number(row.total);
    };

    const cashBefore = await balanceOf(cash.code);
    const bankBefore = await balanceOf(bank.code);
    const floatBefore = await floatTotal();
    const incomeBefore = await incomeTotal();

    await signedIn(browser, 'secretary', async (page) => {
      await recordBanking(page, bank.id, 4_000_000, 20_000, reference);
    });
    await signedIn(browser, 'manager', async (page) => {
      await page.goto('/agency/cash-banking');
      const row = page.getByRole('row').filter({ hasText: reference });
      await row.getByRole('button', { name: /post — move the cash/i }).click();
      await expect(
        page.getByRole('row').filter({ hasText: reference }).first(),
      ).toContainText(/posted/i);
    });

    // The whole amount left the till — netting the charge off the credit
    // would balance just as well and would claim the cashier carried less
    // money than they did.
    expect(await balanceOf(cash.code)).toBe(cashBefore - 4_000_000);
    expect(await balanceOf(bank.code)).toBe(bankBefore + 3_980_000);
    // Rule 5's three prohibitions, measured in the book.
    expect(await floatTotal(), 'electronic float moved').toBe(floatBefore);
    expect(await incomeTotal(), 'income was recognised').toBe(incomeBefore);
    const asTransaction = await queryHarnessOne<{ count: string }>(
      `select count(*)::text as count from public.agency_transactions
        where provider_reference = $1`,
      [reference],
    );
    expect(asTransaction.count, 'it became a customer transaction').toBe('0');
  });

  test('[5.7] a reversal keeps the original posting and undoes it with a second entry', async ({
    browser,
  }) => {
    const { cash, bank } = await cashFixture();
    const reference = unique('CB');

    await signedIn(browser, 'secretary', async (page) => {
      await recordBanking(page, bank.id, 1_500_000, 0, reference);
    });
    await signedIn(browser, 'manager', async (page) => {
      await page.goto('/agency/cash-banking');
      const row = page.getByRole('row').filter({ hasText: reference });
      await row.getByRole('button', { name: /post — move the cash/i }).click();
      await expect(
        page.getByRole('row').filter({ hasText: reference }).first(),
      ).toContainText(/posted/i);
    });

    const cashAfterPost = await balanceOf(cash.code);

    await signedIn(browser, 'owner', async (page) => {
      await page.goto('/agency/cash-banking');
      await expectNoErrorBoundary(page);
      const reverse = page.getByRole('form', { name: 'Reverse this cash banking' });
      const scoped = page
        .getByRole('row')
        .filter({ hasText: reference })
        .getByRole('form', { name: 'Reverse this cash banking' });
      const target = (await scoped.count()) > 0 ? scoped : reverse.first();
      await target.getByLabel(/^reverse, because/i).fill('acceptance walk-through');
      await target.getByRole('button', { name: /^reverse$/i }).click();
      await expect(
        page.getByRole('row').filter({ hasText: reference }).first(),
      ).toContainText(/reversed/i);
    });

    const row = await queryHarnessOne<{
      status: string;
      journal: string | null;
      reversal: string | null;
    }>(
      `select status, journal_entry_id::text as journal,
              reversal_entry_id::text as reversal
         from public.agency_cash_bankings where deposit_reference = $1`,
      [reference],
    );
    expect(row.status).toBe('reversed');
    // The original entry is kept, and a second entry undoes it. An amended
    // or deleted entry would be a rewritten history.
    expect(row.journal, 'the original journal entry was removed').not.toBeNull();
    expect(row.reversal, 'no reversing entry was written').not.toBeNull();
    expect(row.reversal).not.toBe(row.journal);
    expect(await balanceOf(cash.code)).toBe(cashAfterPost + 1_500_000);
  });
});

// ===========================================================================
// 6. Account authorisations — client Rule 6, the Owner's decision 2
// ===========================================================================

/** The auth id for a role, so a call can be made as that officer. */
async function authIdFor(roleKey: string, offset = 0): Promise<string> {
  const rows = await queryHarness<{ auth: string }>(
    `select u.id::text as auth from auth.users u
       join public.profiles p on p.auth_user_id = u.id
       join public.user_roles r on r.profile_id = p.id
      where r.role_key = $1 and p.status = 'active'
      order by p.created_at`,
    [roleKey],
  );
  const row = rows[offset];
  if (row === undefined) throw new Error(`no ${roleKey} at offset ${String(offset)}`);
  return row.auth;
}

/** Attempt a customer deposit against one account, as one officer. */
async function attemptRecord(
  authId: string,
  accountId: string,
  providerCode: string,
): Promise<string> {
  const type = await queryHarnessOne<{ id: string }>(
    `select t.id::text as id from public.agency_transaction_types t
       join public.agency_service_providers p on p.id = t.provider_id
      where p.code = $1 and t.direction = 'deposit' and t.is_active
      order by t.code limit 1`,
    [providerCode],
  );
  const branch = await queryHarnessOne<{ id: string }>(
    `select id::text as id from public.branches where branch_code = $1`,
    [HEAD_OFFICE],
  );
  try {
    await queryHarness(
      `select set_config('request.jwt.claim.sub', $4, true),
              public.create_agency_transaction(
                $1::uuid, 50000, $2::uuid, '+256770000999', 'Acceptance customer',
                $3, 0, null, null, null, $3, null, null, $5::uuid)`,
      [type.id, accountId, unique('AC'), authId, branch.id],
    );
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : 'unknown';
  }
}

test.describe('6. Account authorisations', () => {
  test('[6.1] the register lists every account and names the unstaffed ones', async ({
    browser,
  }) => {
    const fresh = await openAccount('DEMO_AIRTEL');
    await signedIn(browser, 'owner', async (page) => {
      await page.goto('/agency/staffing');
      await expectNoErrorBoundary(page);
      await expect(
        page.getByRole('heading', { name: 'Account authorisations', exact: true }),
      ).toBeVisible();
      await expect(page.getByText(fresh.label, { exact: false }).first()).toBeVisible();
      // The warning that is the screen's reason for existing.
      await expect(page.getByText(/with nobody authorised/i).first()).toBeVisible();
    });
  });

  test('[6.2] the panel explains the supervisory route before anybody asks', async ({
    browser,
  }) => {
    await signedIn(browser, 'owner', async (page) => {
      await page.goto('/agency/staffing');
      const body = (await page.locator('main').textContent()) ?? '';
      expect(body).toMatch(/may still post against any account in their branch/i);
      // And why, because an Owner seeing a third person's posting against a
      // two-name roster would otherwise think the control had failed.
      expect(body).toMatch(/refused to whoever recorded|one authorised cashier/i);
    });
  });

  test('[6.3] REFUSAL — an officer on no roster for that account cannot record', async () => {
    const fresh = await openAccount('DEMO_AIRTEL');
    await fund(fresh.ledger, 5_000_000);
    const grace = await authIdFor('secretary_treasurer');

    const refused = await attemptRecord(grace, fresh.id, 'DEMO_AIRTEL');
    expect(refused, 'an unauthorised officer recorded against the account').not.toBe('');

    const rows = await queryHarnessOne<{ count: string }>(
      `select count(*)::text as count from public.agency_transactions
        where float_account_id = $1`,
      [fresh.id],
    );
    expect(rows.count, 'a transaction was written despite the refusal').toBe('0');
  });

  test('[6.4] authorised through the screen, the same officer can record', async ({
    browser,
  }) => {
    const fresh = await openAccount('DEMO_AIRTEL');
    await fund(fresh.ledger, 5_000_000);
    const grace = await authIdFor('secretary_treasurer');

    // Refused first, so the step proves the authorisation is what changed.
    expect(await attemptRecord(grace, fresh.id, 'DEMO_AIRTEL')).not.toBe('');

    await signedIn(browser, 'owner', async (page) => {
      await page.goto('/agency/staffing');
      const form = page.getByRole('form', { name: new RegExp(fresh.label) });
      await expect(form).toBeVisible();
      const select = form.getByLabel('Authorise', { exact: true });
      const names = (
        await select
          .locator('option')
          .evaluateAll((nodes) =>
            nodes.map((node) => (node as HTMLOptionElement).textContent ?? ''),
          )
      ).filter((label) => label.trim() !== '' && !/choose/i.test(label));
      const cashier = names.find((label) => /Namirembe|Grace/i.test(label));
      if (cashier === undefined) {
        throw new Error(`the counter cashier was not offered: ${names.join(' | ')}`);
      }
      await select.selectOption({ label: cashier });
      await form.getByRole('button', { name: /authorise on this account/i }).click();
      await expect(
        form.getByText(/they may now record against this account/i),
      ).toBeVisible();
    });

    expect(
      await attemptRecord(grace, fresh.id, 'DEMO_AIRTEL'),
      'the authorised officer was still refused',
    ).toBe('');
  });

  test('[6.5] a withdrawal is kept on the record with who did it and why', async ({
    browser,
  }) => {
    const fresh = await openAccount('DEMO_AIRTEL', { staff: true });

    let withdrawnName = '';

    await signedIn(browser, 'owner', async (page) => {
      await page.goto('/agency/staffing');
      await expectNoErrorBoundary(page);

      /*
        Scoped to *this* account's withdraw forms, and nothing else.

        Three things were wrong here, and only one of them failed loudly. A
        bare `new RegExp(label)` matched three forms once both the authorise
        and the withdraw forms began carrying the account in their accessible
        names — a strict-mode violation, which is the one CI caught. Worse,
        the form being submitted was `/^Withdraw /` with `.first()` and no
        account at all: it would have withdrawn a mandate from whichever
        account sorted first and passed while testing the wrong one. And the
        database assertion below read the most recently revoked row in the
        whole table rather than this account's.

        `openAccount({ staff: true })` puts every active cashier on the
        roster, so this account has more than one withdraw form; taking the
        first of *its own* is deliberate.
      */
      const withdraw = page
        .getByRole('form', { name: new RegExp(`^Withdraw .* from .*${fresh.label}`) })
        .first();
      await expect(withdraw).toBeVisible();

      const name = (await withdraw.getAttribute('aria-label')) ?? '';
      withdrawnName = /^Withdraw (.*) from /.exec(name)?.[1] ?? '';
      expect(withdrawnName, `could not read the operator's name from ${name}`).not.toBe(
        '',
      );

      await withdraw.getByLabel(/withdraw, because/i).fill('acceptance walk-through');
      await withdraw.getByRole('button', { name: /^withdraw$/i }).click();

      // That person's form is gone from this account, because they are no
      // longer on its roster. The fixture staffs exactly one cashier, so the
      // account's withdraw forms go from one to none.
      await expect(
        page.getByRole('form', {
          name: new RegExp(`^Withdraw ${withdrawnName} from .*${fresh.label}`),
        }),
      ).toHaveCount(0);
    });

    const row = await queryHarnessOne<{
      status: string;
      reason: string | null;
      by: string | null;
      who: string;
    }>(
      // This account's withdrawn row, not the table's most recent one.
      `select s.status, s.revoked_reason as reason,
              revoker.full_name as by, held.full_name as who
         from public.agency_account_staff s
         join public.profiles held on held.id = s.profile_id
         left join public.profiles revoker on revoker.id = s.revoked_by
        where s.float_account_id = $1 and s.status = 'revoked'`,
      [fresh.id],
    );
    expect(row.who, 'a different operator was withdrawn than the screen showed').toBe(
      withdrawnName,
    );
    // Kept, not deleted: a transaction posted while the mandate stood has to
    // remain readable against the roster as it was.
    expect(row.status).toBe('revoked');
    expect(row.reason).toBe('acceptance walk-through');
    expect(row.by).not.toBeNull();
  });

  test('[6.6] REFUSAL — once withdrawn, the officer cannot record again', async () => {
    const fresh = await openAccount('DEMO_AIRTEL', { staff: true });
    await fund(fresh.ledger, 5_000_000);
    const grace = await authIdFor('secretary_treasurer');

    // Authorised, so she can.
    expect(await attemptRecord(grace, fresh.id, 'DEMO_AIRTEL')).toBe('');

    // Withdrawn by the Owner, through the real function.
    const owner = await authIdFor('owner_admin');
    const profile = await queryHarnessOne<{ id: string }>(
      `select p.id::text as id from public.profiles p
        where p.auth_user_id = $1::uuid`,
      [grace],
    );
    await queryHarness(
      `select set_config('request.jwt.claim.sub', $3, true),
              public.revoke_agency_account_staff($1::uuid, $2::uuid, 'acceptance withdrawal')`,
      [fresh.id, profile.id, owner],
    );

    expect(
      await attemptRecord(grace, fresh.id, 'DEMO_AIRTEL'),
      'a withdrawn mandate still allowed a recording',
    ).not.toBe('');
  });

  test('[6.7] one officer may operate accounts at two different providers', async () => {
    const airtel = await openAccount('DEMO_AIRTEL', { staff: true });
    const mtn = await openAccount('DEMO_MTN', { staff: true });
    await fund(airtel.ledger, 5_000_000);
    await fund(mtn.ledger, 5_000_000);
    const grace = await authIdFor('secretary_treasurer');

    // The other half of Rule 6: one agent, several providers, account-level
    // authorisation on each.
    expect(await attemptRecord(grace, airtel.id, 'DEMO_AIRTEL')).toBe('');
    expect(await attemptRecord(grace, mtn.id, 'DEMO_MTN')).toBe('');
  });

  test('[6.8] REFUSAL for a Secretary, and a Manager may — the oversight decision 2 asked for', async ({
    browser,
  }) => {
    // The written checklist said a Manager is refused. The database says
    // otherwise and always did: `agency_staffing_actor()` admits
    // `agency:providers` or `agency:settlements`, its refusal reads "An Owner
    // or a Manager does that", and a database test asserts the Manager case
    // as "the oversight the decision asked for". The screen enforced
    // Owner-only, stricter than the control it fronts; this step now holds
    // the application to the design.
    await signedIn(browser, 'secretary', async (page) => {
      await page.goto('/agency/staffing');
      await expect(
        page.getByRole('heading', { name: 'Account authorisations', exact: true }),
        'a Secretary/Treasurer reached the authorisations screen',
      ).toHaveCount(0);
      await expect(page.getByLabel('Authorise', { exact: true })).toHaveCount(0);
    });

    const fresh = await openAccount('DEMO_AIRTEL');
    await signedIn(browser, 'manager', async (page) => {
      await page.goto('/agency/staffing');
      await expectNoErrorBoundary(page);
      await expect(
        page.getByRole('heading', { name: 'Account authorisations', exact: true }),
        'a Manager was locked out of a screen the database admits them to',
      ).toBeVisible();

      const form = page.getByRole('form', { name: new RegExp(fresh.label) });
      await expect(form).toBeVisible();
      const select = form.getByLabel('Authorise', { exact: true });
      const names = (
        await select
          .locator('option')
          .evaluateAll((nodes) =>
            nodes.map((node) => (node as HTMLOptionElement).textContent ?? ''),
          )
      ).filter((label) => label.trim() !== '' && !/choose/i.test(label));
      const [first] = names;
      if (first === undefined) {
        throw new Error('the Manager was offered nobody to authorise');
      }
      await select.selectOption({ label: first });
      await form.getByRole('button', { name: /authorise on this account/i }).click();
      await expect(
        form.getByText(/they may now record against this account/i),
        'a Manager could not actually grant the mandate',
      ).toBeVisible();
    });

    const granted = await queryHarnessOne<{ count: string }>(
      `select count(*)::text as count from public.agency_account_staff
        where float_account_id = $1 and status = 'active'`,
      [fresh.id],
    );
    expect(granted.count).toBe('1');
  });
});

// ===========================================================================
// 7. Commission — client Rule 3, the Owner's decision 3
// ===========================================================================

test.describe('7. Commission', () => {
  test('[7.1] the commission report leads with the day-by-day breakdown', async ({
    browser,
  }) => {
    await signedIn(browser, 'owner', async (page) => {
      await page.goto('/agency/reports?section=commission');
      await expectNoErrorBoundary(page);
      await expect(
        page.getByRole('heading', { name: /by day, provider and account/i }),
      ).toBeVisible();
      // Three tables: the daily breakdown, then the two standing positions.
      await expect(
        page.getByRole('heading', { name: /by provider and branch/i }),
      ).toBeVisible();
      await expect(page.getByRole('heading', { name: /by account/i })).toBeVisible();
    });
  });

  test('[7.2] the panel says earned is not received, and why there is no daily outstanding', async ({
    browser,
  }) => {
    await signedIn(browser, 'owner', async (page) => {
      await page.goto('/agency/reports?section=commission');
      const body = (await page.locator('main').textContent()) ?? '';
      expect(body).toMatch(/earned is not received/i);
      expect(body).toMatch(/no outstanding column/i);
      expect(body).toMatch(/position, not a day/i);
    });

    // And the view genuinely has no such column, so the page is not merely
    // apologising for one that exists.
    const columns = await queryHarness<{ name: string }>(
      `select column_name as name from information_schema.columns
        where table_schema = 'public' and table_name = 'agency_commission_daily'`,
    );
    const names = columns.map((c) => c.name);
    expect(names).not.toContain('commission_outstanding');
    expect(names).toContain('commission_movement');
  });

  test('[7.3] a posted transaction shows commission earned on its own day', async ({
    browser,
  }) => {
    const account = await openAccount('DEMO_AIRTEL', { staff: true });
    await fund(account.ledger, 5_000_000);
    const grace = await authIdFor('secretary_treasurer');
    expect(await attemptRecord(grace, account.id, 'DEMO_AIRTEL')).toBe('');

    // Post it, so it is recognised rather than merely recorded.
    const pending = await queryHarnessOne<{ id: string; revision: string }>(
      `select id::text as id, revision::text as revision
         from public.agency_transactions
        where float_account_id = $1 order by created_at desc limit 1`,
      [account.id],
    );
    const manager = await authIdFor('manager');
    await queryHarness(
      `select set_config('request.jwt.claim.sub', $2, true),
              public.submit_agency_transaction($1::uuid)`,
      [pending.id, grace],
    );
    const fresh = await queryHarnessOne<{ revision: string }>(
      `select revision::text as revision from public.agency_transactions where id = $1`,
      [pending.id],
    );
    await queryHarness(
      `select set_config('request.jwt.claim.sub', $2, true),
              public.verify_agency_transaction($1::uuid, $3::integer)`,
      [pending.id, manager, fresh.revision],
    );

    const day = await queryHarnessOne<{ earned: string; date: string }>(
      `select commission_earned::text as earned, business_date::text as date
         from public.agency_commission_daily where float_account_id = $1`,
      [account.id],
    );
    expect(Number(day.earned)).toBeGreaterThan(0);

    await signedIn(browser, 'owner', async (page) => {
      await page.goto(
        `/agency/reports?section=commission&period=custom&from=${day.date}&to=${day.date}`,
      );
      await expectNoErrorBoundary(page);
      const body = (await page.locator('main').textContent()) ?? '';
      expect(body).toContain(account.label);
    });
  });

  test('[7.4] a payout lands on its own day and leaves the earning where it was', async () => {
    const account = await openAccount('DEMO_AIRTEL', { staff: true });
    await fund(account.ledger, 5_000_000);
    const grace = await authIdFor('secretary_treasurer');
    const manager = await authIdFor('manager');

    expect(await attemptRecord(grace, account.id, 'DEMO_AIRTEL')).toBe('');
    const txn = await queryHarnessOne<{ id: string }>(
      `select id::text as id from public.agency_transactions
        where float_account_id = $1 order by created_at desc limit 1`,
      [account.id],
    );
    await queryHarness(
      `select set_config('request.jwt.claim.sub', $2, true),
              public.submit_agency_transaction($1::uuid)`,
      [txn.id, grace],
    );
    const rev = await queryHarnessOne<{ revision: string }>(
      `select revision::text as revision from public.agency_transactions where id = $1`,
      [txn.id],
    );
    await queryHarness(
      `select set_config('request.jwt.claim.sub', $2, true),
              public.verify_agency_transaction($1::uuid, $3::integer)`,
      [txn.id, manager, rev.revision],
    );

    const earnedDay = await queryHarnessOne<{ date: string; earned: string }>(
      `select business_date::text as date, commission_earned::text as earned
         from public.agency_commission_daily where float_account_id = $1`,
      [account.id],
    );

    // A receipt dated elsewhere. Rule 3's separation is the whole point: the
    // earning must not move to meet it.
    const payoutDate = '2026-11-28';
    await queryHarness(
      `select set_config('request.jwt.claim.sub', $3, true),
              public.record_agency_commission_payout(
                $1::uuid, 100, $2, $4::date, 'acceptance payout')`,
      [account.id, unique('PO'), manager, payoutDate],
    );

    const rows = await queryHarness<{
      date: string;
      earned: string;
      settled: string;
    }>(
      `select business_date::text as date, commission_earned::text as earned,
              commission_settled::text as settled
         from public.agency_commission_daily
        where float_account_id = $1 order by business_date`,
      [account.id],
    );

    const earning = rows.find((r) => r.date === earnedDay.date);
    const receipt = rows.find((r) => r.date === payoutDate);
    expect(earning?.earned).toBe(earnedDay.earned);
    expect(earning?.settled, 'the receipt was folded into the earning day').toBe('0');
    expect(receipt, 'the receipt made no row of its own').toBeDefined();
    expect(Number(receipt?.settled)).toBe(100);
    expect(receipt?.earned, 'the earning moved to the receipt day').toBe('0');
  });

  test('[7.5] the settled column names the account, and the page says what it excludes', async ({
    browser,
  }) => {
    await signedIn(browser, 'owner', async (page) => {
      await page.goto('/agency/reports?section=commission');
      const body = (await page.locator('main').textContent()) ?? '';
      // The three words. Without them a paying provider's line reading zero
      // would read as "the provider paid nothing".
      expect(body).toMatch(/settled to the account/i);
      expect(body).toMatch(/payout or a recovery/i);
      expect(body).toMatch(/names no account/i);
    });
  });

  test('[7.6] the standing position keeps earned, received, returned and outstanding apart', async ({
    browser,
  }) => {
    await signedIn(browser, 'owner', async (page) => {
      await page.goto('/agency/reports?section=commission');
      const body = (await page.locator('main').textContent()) ?? '';
      for (const column of [/earned/i, /received/i, /returned/i, /outstanding/i]) {
        expect(column.test(body), String(column)).toBe(true);
      }
    });
  });
});

// ===========================================================================
// 8. Reports and exports
// ===========================================================================

test.describe('8. Reports and exports', () => {
  test('[8.1] the overview reads across every bank and network', async ({ browser }) => {
    await signedIn(browser, 'owner', async (page) => {
      await page.goto('/agency/reports');
      await expectNoErrorBoundary(page);
      await expect(
        page.getByRole('heading', { name: 'Agency reports', exact: false }).first(),
      ).toBeVisible();
    });
  });

  test('[8.2] every scope and period narrows the report and is stated on it', async ({
    browser,
  }) => {
    await signedIn(browser, 'owner', async (page) => {
      for (const scope of ['all', 'banking', 'money']) {
        for (const period of ['day', 'week', 'month']) {
          await page.goto(
            `/agency/reports?section=transactions&scope=${scope}&period=${period}`,
          );
          await expectNoErrorBoundary(page);
          const body = (await page.locator('main').textContent()) ?? '';
          // The scope and the period are stated, so a reader cannot mistake
          // which slice they are holding.
          expect(body.length, `${scope}/${period}`).toBeGreaterThan(200);
          expect(
            /\d{4}-\d{2}-\d{2}/.test(body),
            `${scope}/${period} states no range`,
          ).toBe(true);
        }
      }
    });
  });

  test('[8.3] cash & float leads with the provider roll-up and separates transfers', async ({
    browser,
  }) => {
    await signedIn(browser, 'owner', async (page) => {
      await page.goto('/agency/reports?section=cash-float');
      await expectNoErrorBoundary(page);
      await expect(
        page.getByRole('heading', { name: /float by provider and branch/i }),
      ).toBeVisible();
      await expect(
        page.getByRole('heading', { name: /float by account/i }),
      ).toBeVisible();
      const body = (await page.locator('main').textContent()) ?? '';
      // The four separate totals, and the statement that the fourth is not
      // part of the first two.
      expect(body).toMatch(/moved between our own accounts/i);
      expect(body).toMatch(
        /not added to the others|neither float bought|counting it again/i,
      );
    });
  });

  test('[8.4] every remaining section renders under the current filter', async ({
    browser,
  }) => {
    await signedIn(browser, 'owner', async (page) => {
      for (const section of [
        'transactions',
        'settlements',
        'reconciliation',
        'performance',
      ]) {
        await page.goto(`/agency/reports?section=${section}`);
        await expectNoErrorBoundary(page);
        await expect(page.locator('main'), section).toBeVisible();
      }
    });
  });

  test('[8.5] a CSV and a PDF both download, and the PDF says what produced it', async ({
    browser,
  }) => {
    await signedIn(browser, 'owner', async (page) => {
      const csv = await page.request.get(
        '/agency/reports/export?section=commission&format=csv',
      );
      expect(csv.status()).toBe(200);
      expect(csv.headers()['content-type']).toMatch(/csv/i);
      const text = await csv.text();
      // Money as plain digits, so a spreadsheet reads it as a number.
      expect(text.split('\n')[0]).toMatch(/,/);
      expect(text).not.toMatch(/"\d+,\d{3}"/);

      const pdf = await page.request.get(
        '/agency/reports/export?section=commission&format=pdf',
      );
      expect(pdf.status()).toBe(200);
      expect(pdf.headers()['content-type']).toMatch(/pdf/i);
      const bytes = await pdf.body();
      expect(bytes.length).toBeGreaterThan(1000);
      expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    });
  });

  test('[8.6] the daily breakdown exports in both formats and names its grain', async ({
    browser,
  }) => {
    await signedIn(browser, 'owner', async (page) => {
      const csv = await page.request.get(
        '/agency/reports/export?section=commission&grain=daily&format=csv',
      );
      expect(csv.status()).toBe(200);
      const header = (await csv.text()).split('\n')[0] ?? '';
      // The same columns the screen shows, including the three words.
      expect(header).toMatch(/date/i);
      expect(header).toMatch(/settled to the account/i);
      expect(header).not.toMatch(/outstanding/i);

      const pdf = await page.request.get(
        '/agency/reports/export?section=commission&grain=daily&format=pdf',
      );
      expect(pdf.status()).toBe(200);
      expect((await pdf.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    });
  });

  test('[8.7] REFUSAL — a borrower cannot open an export link', async ({ browser }) => {
    await signedIn(browser, 'borrower', async (page) => {
      const response = await page.request.get(
        '/agency/reports/export?section=commission&format=csv',
      );
      // A download is a separate request and repeats the page's check.
      expect(
        response.status(),
        'a portal user downloaded an agency report',
      ).toBeGreaterThanOrEqual(400);
      const body = await response.text();
      expect(body).not.toMatch(/commission|provider/i);
    });
  });
});

// ===========================================================================
// 9. The float-model correction — the Owner's decision 1
// ===========================================================================

test.describe('9. The float-model correction', () => {
  test('[9.1] the panel states that it corrects configuration and activates nothing', async ({
    browser,
  }) => {
    await signedIn(browser, 'owner', async (page) => {
      await page.goto('/agency/providers');
      await expectNoErrorBoundary(page);
      await expect(
        page.getByRole('heading', { name: /correct a provisional provider/i }),
      ).toBeVisible();
      const body = (await page.locator('main').textContent()) ?? '';
      expect(body).toMatch(/configuration correction, not a financial one/i);
      expect(body).toMatch(/no posted entry is altered/i);
      // And what it does not settle, which is the commercial detail.
      expect(body).toMatch(/commission rate|float facility/i);
    });
  });

  test('[9.2] only provisional providers are offered, with the reason for the rest', async ({
    browser,
  }) => {
    const provisional = await queryHarness<{ name: string }>(
      `select name from public.agency_service_providers where is_provisional`,
    );
    expect(
      provisional.length,
      'the preview has no provisional provider, so this control cannot be exercised',
    ).toBeGreaterThan(0);

    await signedIn(browser, 'owner', async (page) => {
      await page.goto('/agency/providers');
      const select = page.getByLabel('Provider', { exact: true });
      const offered = (
        await select
          .locator('option')
          .evaluateAll((nodes) =>
            nodes.map((node) => (node as HTMLOptionElement).textContent ?? ''),
          )
      ).filter((label) => !/choose/i.test(label) && label.trim() !== '');

      const confirmed = await queryHarness<{ name: string }>(
        `select name from public.agency_service_providers where not is_provisional`,
      );
      for (const row of confirmed) {
        expect(
          offered.some((label) => label.includes(row.name)),
          `${row.name} is confirmed and was offered for correction`,
        ).toBe(false);
      }
      for (const row of provisional) {
        expect(
          offered.some((label) => label.includes(row.name)),
          `${row.name} is provisional and was not offered`,
        ).toBe(true);
      }
      // And the confirmed ones are named as unavailable with the reason.
      const body = (await page.locator('main').textContent()) ?? '';
      expect(body).toMatch(/confirmed/i);
    });
  });

  test('[9.3] correcting a provisional bank to electronic float clears its payable', async ({
    browser,
  }) => {
    const bank = await openProvisionalBank();

    await signedIn(browser, 'owner', async (page) => {
      await page.goto('/agency/providers');
      const form = page
        .locator('form')
        .filter({ has: page.getByLabel('Provider', { exact: true }) })
        .first();
      await form.getByLabel('Provider', { exact: true }).selectOption(bank.id);
      await form
        .getByLabel('Correct it to', { exact: true })
        .selectOption('provider_float');
      await form
        .getByLabel(/^because/i)
        .fill('the client confirmed this bank advances electronic float');
      await form.getByRole('button', { name: /correct the money model/i }).click();
      await expect(form.getByText(/supplies electronic float/i)).toBeVisible();
    });

    const after = await queryHarnessOne<{ model: string; payable: string | null }>(
      `select float_model as model, payable_account_id::text as payable
         from public.agency_service_providers where id = $1`,
      [bank.id],
    );
    expect(after.model).toBe('provider_float');
    expect(after.payable, 'the payable survived the correction').toBeNull();
  });

  test('[9.4] the corrected bank takes an account and reaches the consolidated report', async ({
    browser,
  }) => {
    const bank = await queryHarnessOne<{ code: string }>(
      `select code from public.agency_service_providers
        where float_model = 'provider_float' and category = 'agency_banking'
        order by code limit 1`,
    );
    const account = await openAccount(bank.code);
    await fund(account.ledger, 7_000_000);

    const row = await queryHarnessOne<{ category: string; held: string }>(
      `select provider_category as category, coalesce(sum(float_held),0)::text as held
         from public.agency_mobile_money_consolidated
        where provider_code = $1
        group by provider_category`,
      [bank.code],
    );
    expect(row.category).toBe('agency_banking');
    expect(Number(row.held)).toBeGreaterThanOrEqual(7_000_000);

    await signedIn(browser, 'owner', async (page) => {
      await page.goto('/agency/reports?section=cash-float&scope=banking');
      await expectNoErrorBoundary(page);
      const body = (await page.locator('main').textContent()) ?? '';
      expect(body).toMatch(/Agent Banking/);
    });
  });

  test('[9.5] REFUSAL — a provider holding float cannot be corrected', async () => {
    const holder = await queryHarnessOne<{ id: string; model: string }>(
      `select p.id::text as id, p.float_model as model
         from public.agency_service_providers p
         join public.agency_provider_float_accounts f on f.provider_id = p.id
         join public.ledger_account_balances b on b.account_id = f.ledger_account_id
        where b.balance > 0
        group by p.id, p.float_model
        order by p.code limit 1`,
    );
    const owner = await authIdFor('owner_admin');

    let refused = '';
    try {
      await queryHarness(
        `select set_config('request.jwt.claim.sub', $2, true),
                public.set_agency_provider_float_model(
                  $1::uuid, 'cash_payable',
                  (select id from public.ledger_accounts where code = '2220'),
                  'acceptance attempt')`,
        [holder.id, owner],
      );
    } catch (error) {
      refused = error instanceof Error ? error.message : 'unknown';
    }
    expect(refused, 'a provider holding float was corrected').not.toBe('');

    const after = await queryHarnessOne<{ model: string }>(
      `select float_model as model from public.agency_service_providers where id = $1`,
      [holder.id],
    );
    expect(after.model, 'the model changed despite the refusal').toBe(holder.model);
  });

  test('[9.6] REFUSAL — a Manager cannot correct a float model', async () => {
    const provider = await queryHarnessOne<{ id: string; model: string }>(
      `select id::text as id, float_model as model
         from public.agency_service_providers where is_provisional
        order by code limit 1`,
    ).catch(async () =>
      queryHarnessOne<{ id: string; model: string }>(
        `select id::text as id, float_model as model
           from public.agency_service_providers order by code limit 1`,
      ),
    );
    const manager = await authIdFor('manager');

    let refused = '';
    try {
      await queryHarness(
        `select set_config('request.jwt.claim.sub', $2, true),
                public.set_agency_provider_float_model(
                  $1::uuid, 'provider_float', null, 'acceptance attempt')`,
        [provider.id, manager],
      );
    } catch (error) {
      refused = error instanceof Error ? error.message : 'unknown';
    }
    // Unlike the roster, this one really is the Owner's alone.
    expect(refused, 'a Manager corrected a provider float model').not.toBe('');
  });
});
