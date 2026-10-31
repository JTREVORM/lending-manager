import { createHmac, randomInt } from 'node:crypto';
import { Client } from 'pg';
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { z } from 'zod';
import { assertTestDatabaseUrl } from '../../helpers/test-targets';
import { expectNoErrorBoundary, signOut } from './fixtures';

test.skip(!process.env.E2E_REAL_AUTH_BINARY, 'Requires the pinned real Auth rehearsal');
const base = 'https://127.0.0.1:8443';
const password = 'Real-Auth-Isolated-Only-72!';
const tokenSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
});
async function db() {
  const url = process.env.E2E_DATABASE_URL;
  if (!url) throw new Error('Missing isolated database');
  assertTestDatabaseUrl(url, 'browser');
  const c = new Client({ connectionString: url });
  await c.connect();
  return c;
}
async function createAccount(role: string, status = 'active') {
  const phone = '+2567000' + randomInt(10000, 100000);
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const unsigned =
    encode({ alg: 'HS256', typ: 'JWT' }) +
    '.' +
    encode({ role: 'service_role', exp: Math.floor(Date.now() / 1000) + 300 });
  const bearer =
    unsigned +
    '.' +
    createHmac('sha256', 'harness-only-jwt-secret-not-a-real-key-32+')
      .update(unsigned)
      .digest('base64url');
  const response = await fetch('http://127.0.0.1:9999/admin/users', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: phone.slice(1) + '@phone.lending.invalid',
      password,
      email_confirm: true,
      role: 'authenticated',
    }),
  });
  expect(response.status).toBe(200);
  const user = z.object({ id: z.string() }).parse(await response.json());
  const c = await db();
  try {
    const p = await c.query<{ id: string }>(
      'insert into public.profiles(auth_user_id,full_name,phone,status) values($1,$2,$3,$4) returning id',
      [user.id, 'Real Auth ' + role, phone, status],
    );
    const id = p.rows[0]!.id;
    await c.query('insert into public.user_roles(profile_id,role_key) values($1,$2)', [
      id,
      role,
    ]);
    return { phone, id };
  } finally {
    await c.end();
  }
}
async function login(page: Page, phone: string, pwd = password) {
  await page.goto('/login');
  await page.getByLabel('Phone number').fill(phone);
  await page.getByLabel('Password').fill(pwd);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
}
async function cookieSession(context: BrowserContext) {
  const cookies = await context.cookies();
  const parts = cookies
    .filter((c) => c.name.includes('auth-token'))
    .sort((a, b) => a.name.localeCompare(b.name));
  const value = decodeURIComponent(parts.map((c) => c.value).join(''));
  const decoded = value.startsWith('base64-')
    ? Buffer.from(value.slice(7), 'base64url').toString('utf8')
    : value;
  return z
    .object({
      expires_at: z.number(),
      access_token: z.string(),
      refresh_token: z.string(),
    })
    .parse(JSON.parse(decoded));
}

test('real Auth: two tabs renew after JWT expiry without losing identity', async ({
  page,
  context,
}) => {
  test.setTimeout(120000);
  const user = await createAccount('owner_admin');
  await login(page, user.phone);
  const other = await context.newPage();
  await other.goto('/loans');
  const before = await cookieSession(context);
  const remaining = before.expires_at * 1000 - Date.now();
  expect(remaining).toBeGreaterThan(0);
  expect(remaining).toBeLessThanOrEqual(65000);
  await new Promise((resolve) => setTimeout(resolve, remaining + 2200));
  await Promise.all([page.reload(), other.reload()]);
  for (const tab of [page, other]) {
    await expect(tab).not.toHaveURL(/login/);
    await expectNoErrorBoundary(tab);
  }
  const after = await cookieSession(context);
  expect(after.expires_at).toBeGreaterThan(before.expires_at);
  expect(after.access_token !== before.access_token).toBe(true);
  expect(after.refresh_token !== before.refresh_token).toBe(true);
  await other.goto('/users');
  await expect(other).toHaveURL(/users/);
});

test('real Auth: administrator reset, forced recovery, logout and refresh invalidation', async ({
  page,
  request,
}) => {
  test.setTimeout(90000);
  const owner = await createAccount('owner_admin'),
    staff = await createAccount('manager');
  await login(page, owner.phone);
  await page.goto('/users/' + staff.id);
  await page
    .locator('input[name="temporaryPassword"]')
    .fill('Temporary-Recovery-Only-63!');
  await page.getByRole('button', { name: 'Set temporary password', exact: true }).click();
  await expect(
    page.getByText(/must now sign in with the temporary password/i),
  ).toBeVisible();
  const c = await db();
  try {
    expect(
      (
        await c.query<{ must_change_password: boolean }>(
          'select must_change_password from public.profiles where id=$1',
          [staff.id],
        )
      ).rows[0]!.must_change_password,
    ).toBe(true);
  } finally {
    await c.end();
  }
  await signOut(page);
  const old = await request.post(base + '/auth/v1/token?grant_type=password', {
    data: { email: staff.phone.slice(1) + '@phone.lending.invalid', password },
  });
  expect(old.status()).toBe(400);
  const issued = await request.post(base + '/auth/v1/token?grant_type=password', {
    data: {
      email: staff.phone.slice(1) + '@phone.lending.invalid',
      password: 'Temporary-Recovery-Only-63!',
    },
  });
  expect(issued.status()).toBe(200);
  const tokens = tokenSchema.parse(await issued.json());
  const headers = { Authorization: 'Bearer ' + tokens.access_token };
  expect(
    (
      await request.get('http://127.0.0.1:3001/loans?select=id&limit=0', { headers })
    ).status(),
  ).toBe(403);
  await login(page, staff.phone, 'Temporary-Recovery-Only-63!');
  await expect(page).toHaveURL(/account\/password/);
  await page.goto('/loans');
  await expect(page).toHaveURL(/account\/password/);
  await page.locator('input[name="currentPassword"]').fill('Temporary-Recovery-Only-63!');
  await page.locator('input[name="newPassword"]').fill('Recovered-User-Only-91!');
  await page.locator('input[name="confirmPassword"]').fill('Recovered-User-Only-91!');
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(page.getByText(/password has been changed/i)).toBeVisible();
  await page.goto('/loans');
  await expect(page).toHaveURL(/\/loans$/);
  await expectNoErrorBoundary(page);
  const session = await cookieSession(page.context());
  const oldTemporary = await request.post(base + '/auth/v1/token?grant_type=password', {
    data: {
      email: staff.phone.slice(1) + '@phone.lending.invalid',
      password: 'Temporary-Recovery-Only-63!',
    },
  });
  expect(oldTemporary.status()).toBe(400);
  expect(
    (
      await request.get('http://127.0.0.1:3001/loans?select=id&limit=0', {
        headers: { Authorization: 'Bearer ' + session.access_token },
      })
    ).status(),
  ).toBe(200);
  await signOut(page);
  await page.goto('/loans');
  await expect(page).toHaveURL(/login/);
  const refresh = await request.post(base + '/auth/v1/token?grant_type=refresh_token', {
    data: { refresh_token: session.refresh_token },
  });
  expect(refresh.status()).toBe(400);
});

for (const status of ['inactive', 'suspended']) {
  test(
    'real Auth: ' + status + ' account stays denied after token refresh',
    async ({ request }) => {
      const user = await createAccount('manager', status);
      const first = await request.post(base + '/auth/v1/token?grant_type=password', {
        data: { email: user.phone.slice(1) + '@phone.lending.invalid', password },
      });
      expect(first.status()).toBe(200);
      const initial = tokenSchema.parse(await first.json());
      const refreshed = await request.post(
        base + '/auth/v1/token?grant_type=refresh_token',
        { data: { refresh_token: initial.refresh_token } },
      );
      expect(refreshed.status()).toBe(200);
      const token = tokenSchema.parse(await refreshed.json());
      expect(
        (
          await request.get('http://127.0.0.1:3001/loans?select=id&limit=0', {
            headers: { Authorization: 'Bearer ' + token.access_token },
          })
        ).status(),
      ).toBe(403);
    },
  );
}

test('real Auth stack retains anonymous readiness and public health', async ({
  request,
}) => {
  const context = await request.get(
    base + '/rest/v1/rpc/real_auth_request_context_probe',
  );
  expect(context.status()).toBe(200);
  expect(await context.json()).toMatchObject({
    path: '/rpc/real_auth_request_context_probe',
    method: 'GET',
  });
  const readiness = await request.get('http://127.0.0.1:3001/rpc/polytos_readiness');
  expect(readiness.status()).toBe(200);
  expect(await readiness.json()).toBe(true);
  const health = await request.get('/api/health');
  expect(health.status()).toBe(200);
  expect(health.headers()['cache-control']).toContain('no-store');
  expect(await health.json()).toMatchObject({ status: 'ok', dataApi: 'ok' });
});
