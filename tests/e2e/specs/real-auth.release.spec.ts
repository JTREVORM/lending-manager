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

// ===========================================================================
// The forced-password boundary over real HTTP, with a real Auth-issued JWT.
//
// `forced-password-api.spec.ts` covers the same surface, but it mints its own
// HS256 token with the harness secret. That proves PostgREST's behaviour and
// nothing about Auth. Here the token is the one GoTrue issued for a password
// grant, exactly as a browser would hold it, and every assertion below is an
// HTTP status from the real PostgREST binary with the reviewed
// `db-pre-request` hook configured.
//
// The surface is the one the release promises to close: loans, payments, the
// ledger, the report projections, and the financial SECURITY DEFINER RPCs —
// including `ledger_account_balance`, `savings_withdrawable_amount` and
// `assess_meeting_fines`, which have no Row Level Security of their own.
// ===========================================================================

/** A password grant against real Auth. The token a signed-in browser holds. */
async function signIn(phone: string, pwd = password) {
  const response = await fetch(base + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: phone.slice(1) + '@phone.lending.invalid',
      password: pwd,
    }),
  });
  expect(response.status, 'real Auth password grant').toBe(200);
  const tokens = tokenSchema.parse(await response.json());
  // A real Auth JWT, not a locally forged one: three segments, HS256, and a
  // `sub` GoTrue chose. If this ever stopped being Auth's own token the test
  // would silently become a weaker one.
  const claims = JSON.parse(
    Buffer.from(tokens.access_token.split('.')[1]!, 'base64url').toString('utf8'),
  ) as { sub?: string; role?: string; iss?: string };
  expect(claims.role).toBe('authenticated');
  expect(claims.sub).toBeTruthy();
  return tokens;
}

async function setFlag(profileId: string, value: boolean) {
  const c = await db();
  try {
    if (value) {
      await c.query(
        'update public.profiles set must_change_password = true where id = $1',
        [profileId],
      );
    } else {
      // The sanctioned server path, as `lib/auth/password-change.ts` uses it.
      await c.query(
        'select public.confirm_password_change(p.auth_user_id) from public.profiles p where p.id = $1',
        [profileId],
      );
    }
  } finally {
    await c.end();
  }
}

/** Ids from the harness seed, so the RPCs are called on real records. */
async function businessIds() {
  const c = await db();
  try {
    const row = await c.query<{
      ledger_account_id: string | null;
      savings_account_id: string | null;
      meeting_id: string | null;
    }>(`select (select id from public.ledger_accounts order by id limit 1) as ledger_account_id,
               (select id from public.savings_accounts order by id limit 1) as savings_account_id,
               (select id from public.membership_meetings order by id limit 1) as meeting_id`);
    return row.rows[0]!;
  } finally {
    await c.end();
  }
}

test('real Auth JWT: the whole protected surface flips to 403 on a forced flag', async ({
  request,
}) => {
  test.setTimeout(120000);
  const ids = await businessIds();
  expect(ids.ledger_account_id, 'seeded ledger account').toBeTruthy();
  expect(ids.savings_account_id, 'seeded savings account').toBeTruthy();

  const user = await createAccount('owner_admin');
  const tokens = await signIn(user.phone);
  const headers = { Authorization: 'Bearer ' + tokens.access_token };
  const api = 'http://127.0.0.1:3001';

  // Tables, report projections and the financial definer RPCs. GET for the
  // relations and the scalar RPCs; POST for the volatile one.
  const reads: readonly (readonly [string, string])[] = [
    ['GET', '/loans?select=id&limit=1'],
    ['GET', '/loan_payments?select=id&limit=1'],
    ['GET', '/journal_lines?select=id&limit=1'],
    ['GET', '/savings_accounts?select=id&limit=1'],
    ['GET', '/clients?select=id&limit=1'],
    ['GET', '/ledger_account_balances?select=*&limit=1'],
    ['GET', '/loan_balances?select=*&limit=1'],
    ['GET', '/loan_portfolio_report?select=*&limit=1'],
    ['GET', '/dashboard_collection_summary?select=*&limit=1'],
    ['GET', '/income_register?select=*&limit=1'],
    ['GET', '/expense_register?select=*&limit=1'],
    ['GET', '/audit_log?select=id&limit=1'],
    ['GET', '/rpc/ledger_account_balance?p_account_id=' + ids.ledger_account_id],
    [
      'GET',
      '/rpc/savings_withdrawable_amount?p_savings_account_id=' + ids.savings_account_id,
    ],
    ['GET', '/rpc/savings_pledged_amount?p_savings_account_id=' + ids.savings_account_id],
  ];

  // Permitted while the account is in good standing. Recorded as actual
  // statuses rather than asserted blindly: an Owner/Admin may legitimately
  // lack a capability, and a 403 here would otherwise look like the boundary
  // working when it is really the fixture being wrong.
  const allowed: string[] = [];
  for (const [method, path] of reads) {
    const response = await request.fetch(api + path, { method, headers });
    expect([200, 403], `${method} ${path} before`).toContain(response.status());
    if (response.status() === 200) allowed.push(`${method} ${path}`);
  }
  expect(
    allowed.length,
    'an active Owner/Admin must reach some of the protected surface, or this test proves nothing',
  ).toBeGreaterThan(8);

  // `assess_meeting_fines` writes, so it is only exercised when the seed left
  // a meeting to assess; it is asserted denied below either way.
  if (ids.meeting_id) {
    const assess = await request.post(api + '/rpc/assess_meeting_fines', {
      headers,
      data: { p_meeting_id: ids.meeting_id },
    });
    expect([200, 403, 400], 'assess_meeting_fines before').toContain(assess.status());
  }

  // ---- The flag goes up. The same, unexpired, real Auth token. -----------
  await setFlag(user.id, true);

  for (const [method, path] of reads) {
    const denied = await request.fetch(api + path, { method, headers });
    expect(denied.status(), `${method} ${path} after forcing`).toBe(403);
    expect(
      z.object({ code: z.string() }).parse(await denied.json()).code,
      `${method} ${path} code`,
    ).toBe('42501');
  }

  const assessDenied = await request.post(api + '/rpc/assess_meeting_fines', {
    headers,
    data: { p_meeting_id: ids.meeting_id ?? '00000000-0000-4000-8000-000000000001' },
  });
  expect(assessDenied.status(), 'assess_meeting_fines after forcing').toBe(403);
  expect(z.object({ code: z.string() }).parse(await assessDenied.json()).code).toBe(
    '42501',
  );

  // ---- Recovery stays reachable on the same token ------------------------
  const bootstrap = await request.post(api + '/rpc/current_session_context', {
    headers,
    data: {},
  });
  expect(bootstrap.status(), 'recovery bootstrap').toBe(200);
  expect(
    z
      .array(
        z.object({ outcome: z.string(), must_change_password: z.boolean().nullable() }),
      )
      .parse(await bootstrap.json())[0],
  ).toMatchObject({ outcome: 'ok', must_change_password: true });

  for (const path of ['/rpc/record_sign_in', '/rpc/record_security_event']) {
    const recovery = await request.post(api + path, {
      headers,
      data: path.endsWith('record_security_event') ? { p_action: 'auth.signed_in' } : {},
    });
    expect(recovery.status(), path).toBeLessThan(300);
  }
  expect((await request.get(api + '/rpc/polytos_readiness', { headers })).status()).toBe(
    200,
  );
  expect(
    (await request.get(api + '/company_identity?select=*', { headers })).status(),
  ).toBe(200);

  // Escalation attempts on the same token.
  expect(
    (
      await request.patch(api + '/profiles?id=eq.' + user.id, {
        headers,
        data: { must_change_password: false },
      })
    ).status(),
    'self-clearing the flag',
  ).toBe(403);
  expect(
    (
      await request.post(api + '/rpc/confirm_password_change', {
        headers,
        data: { p_auth_user_id: 'x' },
      })
    ).status(),
    'service-only confirmation',
  ).toBe(403);

  // ---- Confirmed change restores exactly what was permitted before ------
  await setFlag(user.id, false);
  for (const entry of allowed) {
    const [method, path] = entry.split(' ') as [string, string];
    const restored = await request.fetch(api + path, { method, headers });
    expect(restored.status(), `${entry} after confirmation`).toBe(200);
  }
});

test('real Auth JWT: a borrower reads only their own records, and none when forced', async ({
  request,
}) => {
  test.setTimeout(90000);
  const api = 'http://127.0.0.1:3001';
  const borrower = await createAccount('client');
  const c = await db();
  let ownLoan: string | undefined;
  let totalLoans = 0;
  try {
    // Link the portal account to one seeded client, then take that client's
    // loan and somebody else's.
    const client = await c.query<{ id: string }>(
      `select c.id from public.clients c
        where exists (select 1 from public.loans l where l.client_id = c.id)
          and c.profile_id is null
        order by c.id limit 1`,
    );
    if (client.rowCount) {
      await c.query('select public.link_client_profile($1, $2)', [
        client.rows[0]!.id,
        borrower.id,
      ]);
      const loan = await c.query<{ id: string }>(
        'select id from public.loans where client_id = $1 order by id limit 1',
        [client.rows[0]!.id],
      );
      ownLoan = loan.rows[0]?.id;
    }
    // Counted as the owner, so it is the real total rather than a filtered
    // one: the isolation claim is that the borrower sees strictly less.
    const all = await c.query<{ n: string }>(
      'select count(*)::text as n from public.loans',
    );
    totalLoans = Number(all.rows[0]!.n);
  } finally {
    await c.end();
  }
  test.skip(!ownLoan, 'The seed left no unlinked client holding a loan');
  expect(
    totalLoans,
    'the seed must hold more than one loan for this to mean anything',
  ).toBeGreaterThan(1);

  const tokens = await signIn(borrower.phone);
  const headers = { Authorization: 'Bearer ' + tokens.access_token };

  const mine = await request.get(api + '/loans?select=id', { headers });
  expect(mine.status()).toBe(200);
  const visible = z.array(z.object({ id: z.string() })).parse(await mine.json());
  expect(
    visible.map((r) => r.id),
    'the borrower sees their own loan',
  ).toContain(ownLoan);
  expect(visible.length, 'a borrower must not see the whole portfolio').toBeLessThan(
    totalLoans,
  );
  const foreign = await request.get(api + '/loan_payments?select=id,loan_id', {
    headers,
  });
  expect(foreign.status()).toBe(200);
  const payments = z
    .array(z.object({ id: z.string(), loan_id: z.string() }))
    .parse(await foreign.json());
  expect(
    payments.filter((p) => !visible.some((l) => l.id === p.loan_id)),
    'no payment belonging to another borrower is visible',
  ).toEqual([]);

  // Another borrower's account sees none of it.
  const stranger = await createAccount('client');
  const strangerTokens = await signIn(stranger.phone);
  const strangerRows = await request.get(api + '/loans?select=id', {
    headers: { Authorization: 'Bearer ' + strangerTokens.access_token },
  });
  expect(strangerRows.status()).toBe(200);
  expect(
    z.array(z.object({ id: z.string() })).parse(await strangerRows.json()),
    'an unlinked portal account sees no loan',
  ).toEqual([]);

  await setFlag(borrower.id, true);
  const forced = await request.get(api + '/loans?select=id', { headers });
  expect(forced.status(), 'forced borrower').toBe(403);
});

test('real Auth stack: an anonymous caller reaches no business route', async ({
  request,
}) => {
  const api = 'http://127.0.0.1:3001';
  for (const path of [
    '/loans?select=id&limit=1',
    '/loan_payments?select=id&limit=1',
    '/journal_lines?select=id&limit=1',
    '/clients?select=id&limit=1',
    '/profiles?select=id&limit=1',
    '/audit_log?select=id&limit=1',
    '/ledger_account_balances?select=*&limit=1',
    '/loan_portfolio_report?select=*&limit=1',
  ]) {
    const response = await request.get(api + path);
    // Anonymous keeps its existing grants and policies: either refused
    // outright, or allowed through to a policy that yields nothing. A row
    // coming back is the failure.
    if (response.status() === 200) {
      expect(await response.json(), 'anonymous ' + path).toEqual([]);
    } else {
      expect([401, 403, 404], 'anonymous ' + path).toContain(response.status());
    }
  }
  for (const [path, body] of [
    [
      '/rpc/ledger_account_balance',
      { p_account_id: '00000000-0000-4000-8000-0000000000ff' },
    ],
    [
      '/rpc/savings_withdrawable_amount',
      { p_savings_account_id: '00000000-0000-4000-8000-0000000000ff' },
    ],
    [
      '/rpc/assess_meeting_fines',
      { p_meeting_id: '00000000-0000-4000-8000-0000000000ff' },
    ],
    ['/rpc/approve_loan', { p_loan_id: '00000000-0000-4000-8000-0000000000ff' }],
  ] as const) {
    const response = await request.post(api + path, { data: body });
    expect(response.status(), 'anonymous ' + path).toBeGreaterThanOrEqual(400);
  }
});
