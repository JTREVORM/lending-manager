/**
 * Public production smoke checks. GET only, no cookies, credentials or writes.
 * Never reuse the mutating browser harness against a hosted application.
 */
import { mkdirSync, writeFileSync } from 'node:fs';

const origin = 'https://lending-manager-ten.vercel.app';
const routes = [
  '/login',
  '/api/health',
  '/membership/policies/transitions',
  '/loans',
  '/savings',
  '/benefits',
  '/finance/ledger',
];
const report = {
  checkedAt: new Date().toISOString(),
  origin,
  checks: [],
  passed: true,
};

for (const path of routes) {
  try {
    const response = await fetch(origin + path, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'POLYTOS-read-only-certification' },
    });
    const location = response.headers.get('location');
    const redirect = location ? new URL(location, origin) : null;
    const cache = response.headers.get('cache-control') ?? '';
    const check = {
      path,
      status: response.status,
      redirectPath: redirect?.pathname ?? null,
      privateOrNoStore: /private|no-store/.test(cache),
      hasContentSecurityPolicy: response.headers.has('content-security-policy'),
      hasContentTypeProtection:
        response.headers.get('x-content-type-options') === 'nosniff',
      passed: false,
    };
    if (path === '/api/health') {
      const health = await response.json();
      check.passed =
        response.status === 200 &&
        health.status === 'ok' &&
        health.dataApi === 'ok' &&
        health.environment === 'production' &&
        check.privateOrNoStore;
    } else if (path === '/login') {
      const html = await response.text();
      check.passed =
        response.status === 200 &&
        /sign in/i.test(html) &&
        check.privateOrNoStore &&
        check.hasContentSecurityPolicy &&
        check.hasContentTypeProtection;
    } else {
      check.passed =
        [302, 303, 307, 308].includes(response.status) &&
        redirect?.origin === origin &&
        redirect.pathname === '/login' &&
        check.privateOrNoStore;
      await response.body?.cancel();
    }
    report.checks.push(check);
    if (!check.passed) report.passed = false;
  } catch {
    report.checks.push({ path, passed: false, error: 'Public GET probe failed.' });
    report.passed = false;
  }
}

mkdirSync('work', { recursive: true });
writeFileSync(
  'work/production-readonly-certification.json',
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
