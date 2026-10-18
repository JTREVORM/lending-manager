/**
 * The visual half of the table review.
 *
 * Opens every record-based screen at the six widths the brief names, saves a
 * screenshot of each, and — the part a screenshot cannot do on its own —
 * measures the things that go wrong when a table is squeezed:
 *
 *   - **The page scrolls sideways.** `documentElement.scrollWidth` past the
 *     viewport means a table escaped its wrapper. This is the failure the
 *     whole exercise is about and it is never acceptable.
 *   - **A cell is taller than two lines of its own text.** A name folded
 *     into four lines sets the height of every other cell in its row, and is
 *     what "squeezed into narrow spaces" looks like when measured.
 *   - **A value is clipped.** `scrollWidth > clientWidth` on a nowrap cell
 *     means text is being cut off with no way to read it.
 *   - **A badge has wrapped.** A status pill broken across two lines is the
 *     most visible symptom of a column below its floor.
 *   - **A scrollable table that a keyboard cannot reach.**
 *
 * Run against a stack that is already up:
 *   node scripts/table-audit.mjs [--out DIR]
 */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';
const PASSWORD = process.env.HARNESS_PASSWORD ?? 'Screenshot#Demo2026';

const outIndex = process.argv.indexOf('--out');
const OUT = outIndex === -1 ? 'screenshots' : process.argv[outIndex + 1];

/** The six widths the brief asks for, named for what they are. */
const WIDTHS = [
  { name: '375-phone', width: 375, height: 900 },
  { name: '430-phone-large', width: 430, height: 930 },
  { name: '768-tablet', width: 768, height: 1024 },
  { name: '1024-tablet-landscape', width: 1024, height: 800 },
  { name: '1366-laptop', width: 1366, height: 850 },
  { name: '1920-desktop', width: 1920, height: 1080 },
];

/** Every record-based screen, by module. */
const SCREENS = [
  ['dashboard', '/'],
  ['clients-register', '/clients'],
  ['loans-register', '/loans'],
  ['loans-by-product', '/loans/by-product'],
  ['payments-register', '/payments'],
  ['payments-summary', '/payments/summary'],
  ['overdue', '/overdue'],
  ['recovery', '/recovery'],
  ['guarantors-register', '/guarantors/register'],
  ['finance', '/finance'],
  ['finance-ledger', '/finance/ledger'],
  ['finance-trial-balance', '/finance/trial-balance'],
  ['finance-expenses', '/finance/expenses'],
  ['reports-loans', '/reports/loans'],
  ['reports-arrears', '/reports/arrears'],
  ['reports-aging', '/reports/aging'],
  ['reports-collections', '/reports/collections'],
  ['reports-guarantors', '/reports/guarantors'],
  ['reports-collateral', '/reports/collateral'],
  ['users', '/users'],
  ['audit', '/audit'],
  ['settings-products', '/settings/products'],
];

/**
 * The measurement, run inside the page.
 *
 * Everything here is read off the laid-out DOM rather than inferred from
 * class names: the question is what the browser actually did with the
 * columns, which is the question a class name cannot answer.
 */
const PROBE = () => {
  const faults = [];

  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth + 1) {
    faults.push({
      kind: 'page-scrolls-sideways',
      detail: `${doc.scrollWidth}px of content in a ${doc.clientWidth}px viewport`,
    });
  }

  for (const cell of document.querySelectorAll('td, th')) {
    const rect = cell.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;

    const text = (cell.textContent ?? '').trim();
    if (text === '') continue;

    const style = getComputedStyle(cell);
    const lineHeight = parseFloat(style.lineHeight) || 16;
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const lines = Math.round((rect.height - padding) / lineHeight);

    // Two lines is the clamp this system allows; a header never wraps.
    const limit = cell.tagName === 'TH' && cell.getAttribute('scope') === 'col' ? 1 : 2;
    if (lines > limit) {
      faults.push({
        kind: 'cell-wraps-past-its-limit',
        detail: `${String(lines)} lines in <${cell.tagName.toLowerCase()}> "${text.slice(0, 48)}"`,
      });
    }

    if (style.whiteSpace === 'nowrap' && cell.scrollWidth > cell.clientWidth + 1) {
      faults.push({
        kind: 'value-clipped',
        detail: `"${text.slice(0, 48)}" cut off at ${String(cell.clientWidth)}px`,
      });
    }
  }

  // A status pill broken over two lines.
  for (const badge of document.querySelectorAll('[class*="rounded-full"], [class*="rounded"]')) {
    const text = (badge.textContent ?? '').trim();
    if (text === '' || text.length > 32) continue;
    const style = getComputedStyle(badge);
    if (!style.display.includes('flex') && !style.display.includes('inline')) continue;
    const lineHeight = parseFloat(style.lineHeight) || 14;
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const rect = badge.getBoundingClientRect();
    if (rect.height - padding > lineHeight * 1.6 && badge.closest('td, th') !== null) {
      faults.push({ kind: 'badge-wrapped', detail: text.slice(0, 32) });
    }
  }

  // A scroller a keyboard cannot reach.
  for (const box of document.querySelectorAll('[data-data-table], [class*="scroll-x"]')) {
    if (box.scrollWidth <= box.clientWidth + 1) continue;
    if (box.getAttribute('tabindex') === '0') continue;
    if (box.querySelector('[tabindex="0"]') !== null) continue;
    faults.push({ kind: 'scroller-not-focusable', detail: box.className.slice(0, 64) });
  }

  return faults;
};

const results = [];

const browser = await chromium.launch();

try {
  // Sign in once and reuse the session across every width.
  const signInContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const signInPage = await signInContext.newPage();
  const phone = process.env.HARNESS_OWNER_PHONE;
  if (phone === undefined) throw new Error('HARNESS_OWNER_PHONE is not set');

  await signInPage.goto(`${BASE}/login`);
  await signInPage.getByLabel('Phone number').fill(phone);
  await signInPage.getByLabel('Password').fill(PASSWORD);
  await signInPage.getByRole('button', { name: /sign in/i }).click();
  await signInPage.waitForURL((url) => !url.pathname.startsWith('/login'), {
    timeout: 30_000,
  });
  const storageState = await signInContext.storageState();
  await signInContext.close();

  for (const size of WIDTHS) {
    const context = await browser.newContext({
      storageState,
      ignoreHTTPSErrors: true,
      viewport: { width: size.width, height: size.height },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    await mkdir(join(OUT, size.name), { recursive: true });

    for (const [name, path] of SCREENS) {
      try {
        await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 45_000 });
      } catch {
        await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      }
      await page.waitForTimeout(400);

      await page.screenshot({
        path: join(OUT, size.name, `${name}.png`),
        fullPage: true,
      });

      const faults = await page.evaluate(PROBE);
      for (const fault of faults) {
        results.push({ width: size.width, screen: name, path, ...fault });
      }
      process.stdout.write(`${size.name} ${name}: ${String(faults.length)} fault(s)\n`);
    }

    await context.close();
  }
} finally {
  await browser.close();
}

await writeFile(join(OUT, 'faults.json'), `${JSON.stringify(results, null, 2)}\n`);

const byKind = new Map();
for (const fault of results) byKind.set(fault.kind, (byKind.get(fault.kind) ?? 0) + 1);

process.stdout.write('\n--- summary ---\n');
if (results.length === 0) process.stdout.write('no layout faults at any width\n');
for (const [kind, count] of [...byKind].sort((a, b) => b[1] - a[1])) {
  process.stdout.write(`${String(count).padStart(5)}  ${kind}\n`);
}
