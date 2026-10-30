import { expect, stateFile, test } from './fixtures';

test.describe('no-data readiness through real PostgREST', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('executes the anonymous RPC and reaches it through the public health route', async ({
    request,
  }) => {
    const response = await request.get(
      process.env.NEXT_PUBLIC_SUPABASE_URL + '/rest/v1/rpc/polytos_readiness',
      {
        headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '' },
      },
    );
    expect(response.status()).toBe(200);
    expect(await response.json()).toBe(true);

    const health = await request.get('/api/health');
    expect(health.status()).toBe(200);
    expect(health.headers()['cache-control']).toContain('no-store');
    expect(await health.json()).toMatchObject({ status: 'ok', dataApi: 'ok' });
  });
});

test.describe('readiness with a signed-in public role', () => {
  test.use({ storageState: stateFile('owner') });

  test('the application remains ready with a real database session', async ({
    request,
  }) => {
    const health = await request.get('/api/health');
    expect(health.status()).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ok', dataApi: 'ok' });
  });
});
