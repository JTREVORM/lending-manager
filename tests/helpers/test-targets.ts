/**
 * Refuse destructive tests unless they target the configured throwaway stack.
 * Parse the hostname: a password or query containing "localhost" is not isolation.
 * Never include a supplied URL in errors because it may contain credentials.
 */
export function assertTestDatabaseUrl(
  value: string,
  target: 'database' | 'browser' = 'database',
): void {
  const prefix = target === 'database' ? 'PGLOCAL' : 'E2E_PG';
  const database =
    process.env[prefix + '_DB'] ||
    (target === 'database' ? 'lending_test' : 'lending_e2e');
  const user = process.env[prefix + '_USER'] || 'lending';
  const port = process.env[prefix + '_PORT'] || '5433';
  const failure = 'Refusing to run: DATABASE_URL must name the isolated test database.';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(failure);
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    !/^[a-z_][a-z0-9_]*_(test|e2e)$/.test(database) ||
    !/^[a-z_][a-z0-9_]*$/.test(user) ||
    !/^[1-9][0-9]*$/.test(port) ||
    Number(port) > 65535 ||
    url.port !== port ||
    url.pathname !== '/' + database ||
    url.username !== user ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(failure);
  }
}

export function assertTestBrowserUrl(value: string): void {
  const failure = 'Refusing to run: E2E_BASE_URL must name the isolated browser stack.';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(failure);
  }
  if (
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.port !== (process.env.E2E_APP_PORT || '3000') ||
    url.pathname !== '/' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(failure);
  }
}
