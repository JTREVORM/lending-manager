import { randomInt, randomUUID, createHmac, scryptSync } from 'node:crypto';
import { Client } from 'pg';
import { test, expect } from '@playwright/test';

import { assertTestDatabaseUrl } from '../../helpers/test-targets';
import { expectNoErrorBoundary, signOut } from './fixtures';

const password = 'Isolated-Gate-Only-43!';
const api = 'http://127.0.0.1:3001';

async function database() {
  const url = process.env.E2E_DATABASE_URL;
  if (!url) throw new Error('E2E_DATABASE_URL is required');
  assertTestDatabaseUrl(url, 'browser');
  const db = new Client({ connectionString: url });
  await db.connect();
  return db;
}

// These accounts exist ONLY in the disposable harness; never hosted Auth proof.
async function account(role: string, status = 'active') {
  const db = await database();
  try {
    const phone = '+2567000' + randomInt(10000, 100000);
    const salt = randomUUID();
    const hash = 'scrypt$' + salt + '$' + scryptSync(password, salt, 64).toString('hex');
    const auth = await db.query<{ id: string }>(
      'insert into auth.users(email, encrypted_password) values ($1, $2) returning id',
      [phone.slice(1) + '@phone.lending.invalid', hash],
    );
    const authId = auth.rows[0]!.id;
    const profile = await db.query<{ id: string }>(
      'insert into public.profiles(auth_user_id, full_name, phone, status) values ($1,$2,$3,$4) returning id',
      [authId, 'Isolated boundary ' + role, phone, status],
    );
    const profileId = profile.rows[0]!.id;
    await db.query('insert into public.user_roles(profile_id,role_key) values ($1,$2)', [
      profileId,
      role,
    ]);
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned =
      encode({ alg: 'HS256', typ: 'JWT' }) +
      '.' +
      encode({
        sub: authId,
        role: 'authenticated',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
    const signature = createHmac('sha256', 'harness-only-jwt-secret-not-a-real-key-32+')
      .update(unsigned)
      .digest('base64url');
    return { authId, profileId, phone, token: unsigned + '.' + signature };
  } finally {
    await db.end();
  }
}

async function force(profileId: string) {
  const db = await database();
  try {
    await db.query(
      'update public.profiles set must_change_password = true where id = $1',
      [profileId],
    );
  } finally {
    await db.end();
  }
}

for (const role of ['owner_admin', 'manager', 'secretary_treasurer']) {
  test(
    role + ': existing JWT immediately loses direct financial API access',
    async ({ request }) => {
      const user = await account(role);
      const headers = { Authorization: 'Bearer ' + user.token };
      const before = await request.get(api + '/loans?select=id', { headers });
      expect(before.status()).toBe(200);
      expect((await before.json()).length).toBeGreaterThan(0);
      await force(user.profileId);
      for (const path of [
        '/loans?select=id',
        '/loan_payments?select=id',
        '/journal_lines?select=id',
        '/savings_accounts?select=id',
        '/profiles?select=*,user_roles!user_roles_profile_id_fkey(*)',
        '/rpc/savings_pledged_amount?p_savings_account_id=00000000-0000-4000-8000-000000000001',
      ]) {
        const denied = await request.get(api + path, { headers });
        expect(denied.status(), path).toBe(403);
        expect((await denied.json()).code).toBe('42501');
      }
      const bootstrap = await request.post(api + '/rpc/current_session_context', {
        headers,
        data: {},
      });
      expect(bootstrap.status()).toBe(200);
      const [context] = await bootstrap.json();
      expect(context).toMatchObject({
        outcome: 'ok',
        profile_id: user.profileId,
        must_change_password: true,
      });
      expect(context.role_keys).toContain(role);
      const forged = await request.post(api + '/rpc/confirm_password_change', {
        headers,
        data: { p_auth_user_id: user.authId },
      });
      expect(forged.status()).toBe(403);
      const patch = await request.patch(api + '/profiles?id=eq.' + user.profileId, {
        headers,
        data: { must_change_password: false },
      });
      expect(patch.status()).toBe(403);
      const write = await request.post(api + '/rpc/approve_loan', {
        headers,
        data: { p_loan_id: '00000000-0000-4000-8000-000000000001' },
      });
      expect(write.status()).toBe(403);
      const db = await database();
      try {
        const result = await db.query(
          'select must_change_password from public.profiles where id=$1',
          [user.profileId],
        );
        expect(result.rows[0].must_change_password).toBe(true);
      } finally {
        await db.end();
      }
    },
  );
}

for (const status of ['inactive', 'suspended']) {
  test(
    status + ': a valid JWT cannot read financial data or regain business identity',
    async ({ request }) => {
      const user = await account('manager', status);
      const headers = { Authorization: 'Bearer ' + user.token };
      expect((await request.get(api + '/loans?select=id', { headers })).status()).toBe(
        403,
      );
      const bootstrap = await request.post(api + '/rpc/current_session_context', {
        headers,
        data: {},
      });
      expect(bootstrap.status()).toBe(200);
      const [context] = await bootstrap.json();
      expect(context).toMatchObject({
        outcome: 'no_active_profile',
        profile_id: null,
        role_keys: [],
      });
    },
  );
}

test('forced account can change its password, regain business access and log out', async ({
  page,
  request,
}) => {
  const user = await account('manager');
  await force(user.profileId);
  await page.goto('/login');
  await page.getByLabel('Phone number').fill(user.phone);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/account\/password/);
  await expectNoErrorBoundary(page);
  await page.reload();
  await expect(page).toHaveURL(/account\/password/);
  await page.goto('/loans');
  await expect(page).toHaveURL(/account\/password/);
  await page.locator('input[name="currentPassword"]').fill(password);
  await page.locator('input[name="newPassword"]').fill('Changed-Only-In-Harness-76!');
  await page.locator('input[name="confirmPassword"]').fill('Changed-Only-In-Harness-76!');
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(page.getByText(/password has been changed/i)).toBeVisible();
  await page.goto('/loans');
  await expect(page).toHaveURL(/\/loans$/);
  await expectNoErrorBoundary(page);
  expect(
    (
      await request.get(api + '/loans?select=id', {
        headers: { Authorization: 'Bearer ' + user.token },
      })
    ).status(),
  ).toBe(200);
  await signOut(page);
  await page.goto('/loans');
  await expect(page).toHaveURL(/login/);
});
