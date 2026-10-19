/**
 * Before-and-after screenshots of one deployment.
 *
 * Points at a base URL and a label, signs in, and captures the representative
 * screens at the two widths that show the difference: a laptop, where the
 * squeeze happened, and a phone, where the card rendering has to hold.
 *
 *   node scripts/capture-pair.mjs --url http://127.0.0.1:3100 --label before
 */
import { chromium } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const BASE = arg('url', 'http://127.0.0.1:3000');
const LABEL = arg('label', 'after');
const OUT = arg('out', '.e2e/compare');
const PASSWORD = process.env.HARNESS_PASSWORD ?? 'Screenshot#Demo2026';
const PHONE = process.env.HARNESS_OWNER_PHONE ?? '+256772100101';

/** One screen per module, chosen for how many columns it carries. */
const SCREENS = [
  ['loans-register', '/loans'],
  ['clients-register', '/clients'],
  ['payments-register', '/payments'],
  ['overdue', '/overdue'],
  ['guarantors-register', '/guarantors/register'],
  ['recovery', '/recovery'],
  ['payments-summary', '/payments/summary'],
  ['finance-ledger', '/finance/ledger'],
  ['audit', '/audit'],
  ['reports-arrears', '/reports/arrears'],
];

const WIDTHS = [
  { name: '1366-laptop', width: 1366, height: 850 },
  { name: '375-phone', width: 375, height: 900 },
];

const exe = process.env.E2E_CHROMIUM ?? '/opt/pw-browsers/chromium';
const browser = await chromium.launch(existsSync(exe) ? { executablePath: exe } : {});

try {
  const signIn = await browser.newContext({ ignoreHTTPSErrors: true });
  const first = await signIn.newPage();
  await first.goto(`${BASE}/login`);
  await first.getByLabel('Phone number').fill(PHONE);
  await first.getByLabel('Password').fill(PASSWORD);
  await first.getByRole('button', { name: /sign in/i }).click();
  await first.waitForURL((url) => !url.pathname.startsWith('/login'), {
    timeout: 30_000,
  });
  const storageState = await signIn.storageState();
  await signIn.close();

  for (const size of WIDTHS) {
    const context = await browser.newContext({
      storageState,
      ignoreHTTPSErrors: true,
      viewport: { width: size.width, height: size.height },
    });
    const page = await context.newPage();
    const dir = join(OUT, size.name);
    await mkdir(dir, { recursive: true });

    for (const [name, path] of SCREENS) {
      await page.goto(`${BASE}${path}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      await page.waitForLoadState('load').catch(() => undefined);
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(dir, `${name}.${LABEL}.png`), fullPage: true });
      process.stdout.write(`${size.name} ${name} (${LABEL})\n`);
    }

    await context.close();
  }
} finally {
  await browser.close();
}
