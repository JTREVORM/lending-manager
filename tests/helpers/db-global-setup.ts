import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Rebuild the test database before the database suite runs.
 *
 * Without this, the suite's result depends on what previous runs left behind —
 * and because the schema is doing its job (the audit trail is append-only, and
 * profiles cannot be deleted while audit rows reference them), leftovers are
 * genuinely hard to clear. Tests that assert "a clean database contains no
 * people" then fail for reasons unrelated to the change being tested.
 *
 * Rebuilding also means every `npm run test:db` re-proves that all migrations
 * apply in order to an empty database, which is otherwise a separate manual
 * step that is easy to skip.
 *
 * Skipped when `DATABASE_URL` points somewhere other than the local throwaway
 * cluster, so this can never drop a database it did not create.
 */
export default function setup(): void {
  const databaseUrl = process.env.DATABASE_URL?.trim();

  if (databaseUrl === undefined || databaseUrl === '') return;

  if (!databaseUrl.includes('localhost') && !databaseUrl.includes('127.0.0.1')) {
    console.warn(
      '\n  DATABASE_URL is not local; leaving the database as it is.\n' +
        '  The database suite expects a throwaway database it may rebuild.\n',
    );
    return;
  }

  const script = join(process.cwd(), 'scripts', 'pg-local.sh');

  try {
    execFileSync('bash', [script, 'migrate'], { stdio: 'pipe' });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not rebuild the test database before the suite.\n${detail}\n\n` +
        'Run `npm run db:local:setup` first, then export DATABASE_URL.',
    );
  }
}
