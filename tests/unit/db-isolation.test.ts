import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import setup from '../helpers/db-global-setup';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn(() => '0\n') }));

beforeEach(() => {
  vi.stubEnv('PGLOCAL_PORT', '5433');
  vi.stubEnv('PGLOCAL_DB', 'lending_test');
  vi.stubEnv('PGLOCAL_USER', 'lending');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('database test isolation', () => {
  it.each([
    'postgresql://lending:example@db.example.com:5433/lending_test',
    'postgresql://localhost:example@db.example.com:5433/lending_test',
    'postgresql://lending@localhost.example.com:5433/lending_test',
    'postgresql://lending@localhost:5433/production',
    'postgresql://lending@localhost:5432/lending_test',
    'postgresql://lending@localhost:5433/lending_test?host=db.example.com',
    'postgresql://lending@localhost:5433/lending_test?port=5432',
    'https://localhost:5433/lending_test',
  ])('refuses an unsafe target before any process or connection: %s', (url) => {
    vi.stubEnv('DATABASE_URL', url);
    const provide = vi.fn();
    expect(() => setup({ provide })).toThrow(/isolated test database/i);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(provide).not.toHaveBeenCalled();
  });

  it('leaves an unconfigured database suite skipped without starting a process', () => {
    vi.stubEnv('DATABASE_URL', '');
    setup({ provide: vi.fn() });
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('passes the validated URL as a literal psql argument without a shell', () => {
    const url = 'postgresql://lending@localhost:5433/lending_test';
    vi.stubEnv('DATABASE_URL', url);
    const provide = vi.fn();
    setup({ provide });
    expect(execFileSync).toHaveBeenCalledWith(
      'psql',
      [url, '-qtA', '-c', 'select coalesce(max(id), 0) from public.audit_log'],
      expect.objectContaining({ encoding: 'utf8' }),
    );
    expect(provide).toHaveBeenCalledWith('seedAuditBoundary', 0);
  });
});
