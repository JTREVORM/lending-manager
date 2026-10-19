import { chromium } from '@playwright/test';
import { existsSync } from 'node:fs';
const exe = '/opt/pw-browsers/chromium';
const b = await chromium.launch(existsSync(exe) ? { executablePath: exe } : {});
for (const w of [1366, 1440, 1920]) {
  const c = await b.newContext({ viewport: { width: w, height: 900 } });
  const p = await c.newPage();
  await p.goto('http://127.0.0.1:3000/login');
  await p.getByLabel('Phone number').fill('+256772100101');
  await p.getByLabel('Password').fill('Screenshot#Demo2026');
  await p.getByRole('button', { name: /sign in/i }).click();
  await p.waitForURL((u) => !u.pathname.startsWith('/login'));
  await p.goto('http://127.0.0.1:3000/loans', { waitUntil: 'domcontentloaded' });
  await p.waitForLoadState('load').catch(() => {});
  await p.waitForTimeout(400);
  const r = await p.evaluate(() => {
    const box = document.querySelector('[data-data-table]');
    const t = box?.querySelector('table');
    const cols = [...(t?.querySelectorAll('thead th') ?? [])].map((th) => ({
      h: (th.textContent ?? '').trim().slice(0, 14),
      w: Math.round(th.getBoundingClientRect().width),
    }));
    return {
      box: box?.clientWidth,
      table: Math.round(t?.getBoundingClientRect().width ?? 0),
      cols,
    };
  });
  console.log(
    `\n${w}: container ${r.box}px, table ${r.table}px, overflow ${r.table - (r.box ?? 0)}px`,
  );
  console.log(r.cols.map((c) => `${c.h}=${c.w}`).join('  '));
  await c.close();
}
await b.close();
