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
 *
 * ## The seed-era boundary
 *
 * After the rebuild, every audit row in the database came from the migrations
 * and the seed, because nothing else has run yet. The highest id at that
 * moment is therefore the line between "written by the seed" and "written by
 * a test", and it is published here for the one assertion that needs it.
 *
 * Without it, `schema.test.ts`'s claim that the seed writes no audit record
 * was order-dependent: `createTestUser` grants a role, which writes a
 * `user.role_granted` row, so whether the assertion passed depended on
 * whether some other file's fixtures had run and torn down yet. The claim was
 * always about the seed; this makes the measurement match it.
 */
// Typed structurally rather than against a Vitest type: the name of the
// global-setup context has moved between major versions, and this is the one
// member used.
interface SetupContext {
  readonly provide: (key: 'seedAuditBoundary', value: number) => void;
}

export default function setup({ provide }: SetupContext): void {
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

  // Read through psql rather than opening a pool: global setup runs in its
  // own process and a pool here would outlive it.
  const highest = execFileSync(
    'bash',
    [
      '-c',
      `psql "${databaseUrl}" -qtA -c "select coalesce(max(id), 0) from public.audit_log"`,
    ],
    { encoding: 'utf8', env: { ...process.env, PATH: pgPath() } },
  ).trim();

  provide('seedAuditBoundary', Number(highest));
}

/** The PostgreSQL binaries `pg-local.sh` just used, so `psql` resolves. */
function pgPath(): string {
  const bin = execFileSync('bash', ['-c', 'ls -d /usr/lib/postgresql/*/bin | head -1'], {
    encoding: 'utf8',
  }).trim();
  return bin === '' ? (process.env.PATH ?? '') : `${bin}:${process.env.PATH ?? ''}`;
}

declare module 'vitest' {
  interface ProvidedContext {
    readonly seedAuditBoundary: number;
  }
}
