import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET, dynamic, revalidate } from '@/app/api/health/route';
import { resetPublicEnvCache } from '@/lib/env.public';
const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('@/lib/logger', () => ({ logger: { warn } }));

const fetchMock = vi.fn<typeof fetch>();
const key = 'sb_publishable_test_readiness_key';
const url = 'https://readiness-test.supabase.co';

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', url);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', key);
  vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_APP_VERSION', '0.1.0');
  vi.stubEnv('SUPABASE_SECRET_KEY', 'sb_secret_test_never_used');
  resetPublicEnvCache();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  warn.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetPublicEnvCache();
});

async function assertHealth(status: number) {
  const response = await GET();
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe(
    'no-store, no-cache, must-revalidate',
  );
  expect(await response.json()).toEqual({
    status: status === 200 ? 'ok' : 'degraded',
    dataApi: status === 200 ? 'ok' : 'unreachable',
    version: '0.1.0',
    environment: 'production',
  });
  const logged = JSON.stringify(warn.mock.calls);
  for (const privateValue of [
    key,
    url,
    'sb_secret_test_never_used',
    'private upstream detail',
  ]) {
    expect(logged).not.toContain(privateValue);
  }
}

describe('public no-data readiness', () => {
  it.each([
    key,
    [
      'eyJhbGciOiJIUzI1NiJ9',
      btoa(JSON.stringify({ role: 'anon' })).replace(/=+$/, ''),
      'test_signature',
    ].join('.'),
  ])('accepts exact readiness success with a supported public key', async (publicKey) => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', publicKey);
    resetPublicEnvCache();
    fetchMock.mockResolvedValue(Response.json(true));
    await assertHealth(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe(url + '/rest/v1/rpc/polytos_readiness');
    expect(call?.[1]?.method).toBe('GET');
    expect(call?.[1]?.redirect).toBe('error');
    expect(call?.[1]?.headers).toEqual({ apikey: publicKey });
    expect(call?.[1]?.cache).toBe('no-store');
    expect(call?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(warn).not.toHaveBeenCalled();
    expect(dynamic).toBe('force-dynamic');
    expect(revalidate).toBe(0);
  });

  it.each([400, 401, 403, 404, 429, 500, 502, 503, 504])(
    'returns 503 when the gateway or RPC returns %i, even with a true body',
    async (status) => {
      fetchMock.mockResolvedValue(Response.json(true, { status }));
      await assertHealth(503);
    },
  );

  it.each([false, null, 'true', 1, [], [true], { ready: true }])(
    'rejects a JSON value other than boolean true: %j',
    async (body) => {
      fetchMock.mockResolvedValue(Response.json(body));
      await assertHealth(503);
    },
  );

  it.each([
    '',
    '<html>private upstream detail</html>',
    'true trailing data',
    '{invalid json',
  ])('rejects empty or malformed JSON without disclosing it', async (body) => {
    fetchMock.mockResolvedValue(new Response(body));
    await assertHealth(503);
  });

  it('rejects a successful status other than the RPC contract', async () => {
    fetchMock.mockResolvedValue(Response.json(true, { status: 201 }));
    await assertHealth(503);
  });

  it('does not treat a redirect as readiness', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: 'https://private.invalid' },
      }),
    );
    await assertHealth(503);
  });

  it('handles connection failure without logging exception details', async () => {
    fetchMock.mockRejectedValue(new Error('private upstream detail ' + url + ' ' + key));
    await assertHealth(503);
  });

  it('keeps the four-second timeout for an unavailable service', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener(
            'abort',
            () => reject(new Error('test request aborted')),
            { once: true },
          );
        }),
    );
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((delay) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException('Timed out', 'TimeoutError')),
        delay,
      );
      return controller.signal;
    });
    const result = assertHealth(503);
    await vi.advanceTimersByTimeAsync(4_000);
    await result;
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(true);
    expect(timeout).toHaveBeenCalledWith(4_000);
  });

  it('handles a failed response body read without leaking its exception', async () => {
    const response = Response.json(true);
    vi.spyOn(response, 'json').mockRejectedValue(
      new Error('private upstream detail ' + key),
    );
    fetchMock.mockResolvedValue(response);
    await assertHealth(503);
  });

  it('refuses invalid configuration before making a request or using the admin key', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_secret_test_never_used');
    resetPublicEnvCache();
    await assertHealth(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
