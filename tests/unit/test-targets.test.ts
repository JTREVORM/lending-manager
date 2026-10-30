import { describe, expect, it, vi, afterEach } from 'vitest';

import { assertTestBrowserUrl, assertTestDatabaseUrl } from '../helpers/test-targets';

afterEach(() => vi.unstubAllEnvs());

describe('isolated test targets', () => {
  it('accepts only the configured local test database', () => {
    vi.stubEnv('PGLOCAL_PORT', '5433');
    vi.stubEnv('PGLOCAL_DB', 'lending_test');
    vi.stubEnv('PGLOCAL_USER', 'lending');
    expect(() =>
      assertTestDatabaseUrl('postgresql://lending@127.0.0.1:5433/lending_test'),
    ).not.toThrow();
    expect(() =>
      assertTestDatabaseUrl('postgresql://lending@127.0.0.1:5433/postgres'),
    ).toThrow(/isolated test database/);
  });

  it('matches custom cluster settings and rejects a non-test database name', () => {
    vi.stubEnv('PGLOCAL_PORT', '5544');
    vi.stubEnv('PGLOCAL_DB', 'certification_test');
    vi.stubEnv('PGLOCAL_USER', 'tester');
    expect(() =>
      assertTestDatabaseUrl('postgresql://tester@127.0.0.1:5544/certification_test'),
    ).not.toThrow();
    vi.stubEnv('PGLOCAL_DB', 'production');
    expect(() =>
      assertTestDatabaseUrl('postgresql://tester@127.0.0.1:5544/production'),
    ).toThrow(/isolated test database/);
  });

  it('protects the browser database separately from the unit database', () => {
    vi.stubEnv('E2E_PG_PORT', '5433');
    vi.stubEnv('E2E_PG_DB', 'lending_e2e');
    vi.stubEnv('E2E_PG_USER', 'lending');
    expect(() =>
      assertTestDatabaseUrl('postgresql://lending@127.0.0.1:5433/lending_e2e', 'browser'),
    ).not.toThrow();
    expect(() =>
      assertTestDatabaseUrl('postgresql://lending@remote.invalid/lending_e2e', 'browser'),
    ).toThrow(/isolated test database/);
  });

  it.each([
    'not a URL',
    'http://localhost:3000',
    'postgresql://lending:example@localhost:5433/lending_test',
    'postgresql://lending@localhost:5433/lending_test#example',
    'postgresql://lending@localhost:5433/lending_test?hostaddr=192.0.2.1',
    'postgresql://lending@localhost:5433/lending_test?dbname=production',
  ])('rejects ambiguous database connection syntax: %s', (url) => {
    expect(() => assertTestDatabaseUrl(url)).toThrow(/isolated test database/);
  });

  it.each([
    'https://lending-manager-ten.vercel.app',
    'http://localhost.example.com:3000',
    'http://localhost:4000',
    'http://127.0.0.1:3000/login',
    'http://127.0.0.1:3000/?target=production',
    'http://example@127.0.0.1:3000/',
    'not a URL',
  ])('refuses browser writes outside the isolated stack: %s', (url) => {
    vi.stubEnv('E2E_APP_PORT', '3000');
    expect(() => assertTestBrowserUrl(url)).toThrow(/isolated browser stack/);
  });

  it('accepts the configured loopback browser origin', () => {
    vi.stubEnv('E2E_APP_PORT', '3000');
    expect(() => assertTestBrowserUrl('http://127.0.0.1:3000')).not.toThrow();
    vi.stubEnv('E2E_APP_PORT', '4000');
    expect(() => assertTestBrowserUrl('http://localhost:4000')).not.toThrow();
  });
});
